import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { claudeEnv, sandboxEnv, createClaudeAdapter, friendlyError, modelName, redact, type QueryFn, type SdkMessage } from '../src/index.js';

// Obviously fake test value, not a real key.
const FAKE_KEY = 'sk-ant-test-0000000000000000';

function fakeQuery(messages: SdkMessage[], seen: { options?: Record<string, unknown>; prompt?: string } = {}): QueryFn {
  return ({ prompt, options }) => {
    seen.prompt = prompt;
    seen.options = options;
    return (async function* () {
      for (const m of messages) yield m;
    })();
  };
}

const success: SdkMessage = {
  type: 'result',
  subtype: 'success',
  result: 'ready',
  total_cost_usd: 0.0004,
  modelUsage: {
    'claude-haiku-5-5': { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 100, cacheCreationInputTokens: 5 },
  },
};

describe('Claude adapter', () => {
  it('returns the answer, tokens and cost from the result message', async () => {
    const seen: { options?: Record<string, unknown>; prompt?: string } = {};
    const adapter = createClaudeAdapter({ apiKey: FAKE_KEY, query: fakeQuery([{ type: 'system' }, success], seen) });
    const out = await adapter.run({ job: 'read', prompt: 'hi', model: 'claude-haiku-5-5' });
    expect(out).toEqual({ text: 'ready', usage: { inputTokens: 115, outputTokens: 2, costUsd: 0.0004 } });
    expect(seen.prompt).toBe('hi');
  });

  it('runs locked down: no tools, no PC settings, one turn, key only in env', async () => {
    const seen: { options?: Record<string, unknown> } = {};
    const adapter = createClaudeAdapter({ apiKey: FAKE_KEY, maxBudgetUsd: 0.05, query: fakeQuery([success], seen) });
    await adapter.run({ job: 'read', prompt: 'hi', model: 'claude-haiku-5-5' });
    const o = seen.options!;
    expect(o.model).toBe('claude-haiku-5-5');
    expect(o.tools).toEqual([]);
    expect(o.settingSources).toEqual([]);
    expect(o.maxTurns).toBe(1);
    expect(o.persistSession).toBe(false);
    expect(o.maxBudgetUsd).toBe(0.05);
    expect((o.env as Record<string, string>).ANTHROPIC_API_KEY).toBe(FAKE_KEY);
    expect((o.env as Record<string, string>).CLAUDE_CONFIG_DIR).toContain('ai-prototype-claude');
    const { env, ...rest } = o;
    expect(JSON.stringify(rest)).not.toContain(FAKE_KEY);
    expect(env).toBeDefined();
  });

  it('turns an error result into a plain message without the key', async () => {
    const bad: SdkMessage = { type: 'result', subtype: 'error_during_execution', errors: [`401 invalid x-api-key ${FAKE_KEY}`] };
    const adapter = createClaudeAdapter({ apiKey: FAKE_KEY, query: fakeQuery([bad]) });
    await expect(adapter.run({ job: 'read', prompt: 'hi', model: 'm' })).rejects.toThrow(
      'Claude did not accept the API key. Check it in Settings.',
    );
  });

  it('hides the key if the SDK throws with it in the message', async () => {
    const throwing: QueryFn = () => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error(`odd failure ${FAKE_KEY}`)) }),
    });
    const adapter = createClaudeAdapter({ apiKey: FAKE_KEY, query: throwing });
    const err = await adapter.run({ job: 'read', prompt: 'hi', model: 'm' }).catch((e: Error) => e);
    expect((err as Error).message).toBe('odd failure [key hidden]');
  });

  it('complains when there is no result or no key', async () => {
    const adapter = createClaudeAdapter({ apiKey: FAKE_KEY, query: fakeQuery([{ type: 'system' }]) });
    await expect(adapter.run({ job: 'read', prompt: 'hi', model: 'm' })).rejects.toThrow('ended without an answer');
    expect(() => createClaudeAdapter({ apiKey: '' })).toThrow('No Claude API key saved');
  });
});

describe('claudeEnv', () => {
  it('passes only safe variables, its own config folder and the saved key', () => {
    const env = claudeEnv(FAKE_KEY, {
      PATH: '/bin',
      HOME: '/home/j',
      HTTPS_PROXY: 'http://proxy',
      ANTHROPIC_API_KEY: 'sk-ant-other-key-1111111111',
      ANTHROPIC_AUTH_TOKEN: 'other-token',
      CLAUDE_CODE_OAUTH_TOKEN: 'other-oauth',
      ANTHROPIC_BASE_URL: 'http://elsewhere',
      SOME_SECRET: 'x',
    });
    expect(env.ANTHROPIC_API_KEY).toBe(FAKE_KEY);
    expect(env.PATH).toBe('/bin');
    expect(env.HOME).toBe('/home/j');
    expect(env.HTTPS_PROXY).toBe('http://proxy');
    expect(env.CLAUDE_CONFIG_DIR).toContain('ai-prototype-claude');
    for (const gone of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'SOME_SECRET']) {
      expect(env[gone]).toBeUndefined();
    }
  });
});

describe('helpers', () => {
  it('redacts every copy of the secret', () => {
    expect(redact('a S b S', 'S')).toBe('a [key hidden] b [key hidden]');
    expect(redact('abc', '')).toBe('abc');
  });

  it('gives plain reasons for common failures', () => {
    expect(friendlyError('Claude Code returned an error result: Invalid API key · Fix external API key')).toBe(
      'Claude did not accept the API key. Check it in Settings.',
    );
    expect(friendlyError('Your credit balance is too low')).toBe('Your Anthropic account has no credit left.');
    expect(friendlyError('getaddrinfo ENOTFOUND api.anthropic.com')).toContain('internet');
    expect(friendlyError('error_max_budget_usd')).toContain('cost limit');
    expect(friendlyError('something else')).toBe('something else');
  });

  it('names models plainly', () => {
    expect(modelName('claude-haiku-5-5')).toBe('Haiku 5.5');
    expect(modelName('claude-opus-5')).toBe('Opus 5');
    expect(modelName('gpt-x')).toBe('gpt-x');
  });
});

describe('Claude build runs', () => {
  it('gives the build shell the sandbox home when asked, and today’s env when not', async () => {
    const run = async (sandbox?: { home: string; pnpmStore?: string }) => {
      const seen: { options?: Record<string, unknown> } = {};
      const adapter = createClaudeAdapter({ apiKey: FAKE_KEY, query: fakeQuery([success], seen) });
      await adapter.build!({ model: 'm', prompt: 'p', cwd: '/x', checkTool: async () => ({ allow: true }), ...(sandbox ? { sandbox } : {}) });
      return seen.options!.env as Record<string, string>;
    };
    const boxed = await run({ home: join(tmpdir(), 'sb'), pnpmStore: '/store' });
    expect(boxed.HOME).toBe(join(tmpdir(), 'sb'));
    expect(boxed.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(boxed.npm_config_store_dir).toBe('/store');
    expect(boxed.ANTHROPIC_API_KEY).toBe(FAKE_KEY);
    expect(boxed.CLAUDE_CONFIG_DIR).toContain('ai-prototype-claude');
    const plain = await run();
    expect(plain).toEqual(claudeEnv(FAKE_KEY));
    expect('GIT_CONFIG_NOSYSTEM' in plain).toBe(false);
  });

  type Can = (name: string, input: Record<string, unknown>, o: { signal: AbortSignal }) => Promise<{ behavior: string; message?: string }>;

  /** Stands in for the SDK: asks canUseTool about each tool call, as the real one does. */
  function agent(calls: { name: string; input: Record<string, unknown> }[], answers: unknown[], seen: { options?: Record<string, unknown> } = {}): QueryFn {
    return ({ options }) => {
      seen.options = options;
      return (async function* () {
        for (const c of calls) {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: c.name, input: c.input }] } };
          answers.push(await (options.canUseTool as Can)(c.name, c.input, { signal: new AbortController().signal }));
        }
        yield { ...success, result: 'Built F-01.', total_cost_usd: 0.31 };
      })();
    };
  }

  it('works in the given folder with file and shell tools, asking the app before each call', async () => {
    const seen: { options?: Record<string, unknown> } = {};
    const answers: unknown[] = [];
    const steps: string[] = [];
    const asked: string[] = [];
    const adapter = createClaudeAdapter({
      apiKey: FAKE_KEY,
      maxBudgetUsd: 1,
      query: agent(
        [
          { name: 'Write', input: { file_path: '/runs/F-01/src/login.tsx', content: 'x' } },
          { name: 'Bash', input: { command: 'git   push origin main' } },
        ],
        answers,
        seen,
      ),
    });
    const r = await adapter.build!({
      model: 'claude-sonnet-5-5',
      prompt: 'Build F-01',
      cwd: '/runs/F-01',
      onStep: (s) => steps.push(s),
      async checkTool(tool) {
        asked.push(tool);
        return tool === 'Bash' ? { allow: false, reason: 'pushing code needs joshua’s OK' } : { allow: true };
      },
    });
    expect(seen.options).toMatchObject({
      model: 'claude-sonnet-5-5',
      cwd: '/runs/F-01',
      tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
      permissionMode: 'default',
      settingSources: [],
      maxBudgetUsd: 1,
    });
    expect(asked).toEqual(['Write', 'Bash']);
    expect(answers).toEqual([
      { behavior: 'allow', updatedInput: { file_path: '/runs/F-01/src/login.tsx', content: 'x' } },
      { behavior: 'deny', message: 'pushing code needs joshua’s OK' },
    ]);
    expect(steps).toEqual(['Write /runs/F-01/src/login.tsx', 'Run git push origin main']);
    expect(r).toEqual({ text: 'Built F-01.', usage: { inputTokens: 115, outputTokens: 2, costUsd: 0.31 } });
  });

  it('says Stopped when the run is stopped', async () => {
    const stop = new AbortController();
    const query: QueryFn = ({ options }) =>
      (async function* () {
        stop.abort();
        if ((options.abortController as AbortController).signal.aborted) throw new Error('aborted by user');
        yield success;
      })();
    const adapter = createClaudeAdapter({ apiKey: FAKE_KEY, query });
    await expect(adapter.build!({ model: 'm', prompt: 'p', cwd: '/x', signal: stop.signal, checkTool: async () => ({ allow: true }) })).rejects.toThrow('Stopped.');
  });
});

describe('sandboxEnv', () => {
  const home = join(tmpdir(), 'sb-home');
  const base = { PATH: '/bin', HOME: '/real/joshua', USERPROFILE: 'C:\\Users\\joshua', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\joshua', APPDATA: 'x', LOCALAPPDATA: 'y', ANTHROPIC_API_KEY: FAKE_KEY, CLAUDE_CONFIG_DIR: '/cfg' };
  const inside = (p: string | undefined) => (p ?? '').startsWith(home + sep);

  function gitConfig(env: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++) out[env[`GIT_CONFIG_KEY_${i}`]!] = env[`GIT_CONFIG_VALUE_${i}`]!;
    return out;
  }

  it('moves home inside the sandbox and drops the drive and path variables', () => {
    const e = sandboxEnv(base, home);
    expect(e.HOME).toBe(home);
    expect(e.USERPROFILE).toBe(home);
    expect(inside(e.APPDATA)).toBe(true);
    expect(inside(e.LOCALAPPDATA)).toBe(true);
    expect('HOMEDRIVE' in e).toBe(false);
    expect('HOMEPATH' in e).toBe(false);
    for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'npm_config_cache']) expect(inside(e[k])).toBe(true);
    expect(base.HOME).toBe('/real/joshua'); // the input is not changed
  });

  it('locks git down: no system or global config, no login, no push, a local author', () => {
    const e = sandboxEnv(base, home);
    expect(e.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(inside(e.GIT_CONFIG_GLOBAL)).toBe(true);
    expect(e.GIT_TERMINAL_PROMPT).toBe('0');
    expect(e.GCM_INTERACTIVE).toBe('never');
    const c = gitConfig(e);
    expect(c['credential.helper']).toBe('');
    expect(c['remote.origin.pushurl']).toMatch(/^blocked:/);
    expect(c['remote.pushDefault']).toBe('blocked');
    expect(e.GIT_AUTHOR_NAME).toBe('AI build');
    expect(e.GIT_COMMITTER_EMAIL).toBe('ai-build@localhost');
  });

  it('keeps the key and the Claude config folder, and sets the pnpm store only when given', () => {
    const e = sandboxEnv(base, home);
    expect(e.ANTHROPIC_API_KEY).toBe(FAKE_KEY);
    expect(e.CLAUDE_CONFIG_DIR).toBe('/cfg');
    expect(e.PATH).toBe('/bin');
    expect('npm_config_store_dir' in e).toBe(false);
    expect(sandboxEnv(base, home, { pnpmStore: '/store' }).npm_config_store_dir).toBe('/store');
  });

  it('really cannot push from a clone, but can still commit', async () => {
    const run = promisify(execFile);
    const root = await mkdtemp(join(tmpdir(), 'aip-sandbox-'));
    try {
      const sb = join(root, 'home');
      await mkdir(sb);
      await writeFile(join(sb, '.gitconfig'), '');
      const env = sandboxEnv({ PATH: process.env.PATH ?? process.env.Path ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, sb);
      const g = (cwd: string, ...args: string[]) => run('git', args, { cwd, env });
      const origin = join(root, 'origin.git');
      await g(root, 'init', '--bare', '-q', origin);
      const copy = join(root, 'copy');
      await g(root, 'clone', '-q', origin, copy);
      await writeFile(join(copy, 'a.txt'), 'hi');
      await g(copy, 'add', '.');
      await g(copy, 'commit', '-q', '-m', 'local commit');
      expect((await g(copy, 'log', '-1', '--format=%an')).stdout.trim()).toBe('AI build');
      await expect(g(copy, 'push', 'origin', 'HEAD')).rejects.toThrow();
      expect((await g(origin, 'for-each-ref')).stdout.trim()).toBe(''); // nothing reached origin
      expect(await readFile(join(copy, 'a.txt'), 'utf8')).toBe('hi');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

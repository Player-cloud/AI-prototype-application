import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClaudeLoopAdapter, failureCause, globToRegExp, insideRoot, replyCostUsd, type BuildTask, type FetchFn, type ShellFn } from '../src/index.js';

// Obviously fake test value, not a real key.
const KEY = 'sk-ant-test-0000000000000000';
const MODEL = 'claude-sonnet-5-5';
const PRICES = { [MODEL]: { inputPerM: 3, outputPerM: 15 } };

type Reply = { status?: number; body: unknown };
const text = (t: string, usage = { input_tokens: 100, output_tokens: 10 }): Reply => ({ body: { content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage } });
const tool = (name: string, input: Record<string, unknown>, id = 't1', usage = { input_tokens: 100, output_tokens: 10 }): Reply => ({
  body: { content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', usage },
});

/** A fetch that answers from a list, and remembers every request. */
function scripted(replies: Reply[]) {
  const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetch: FetchFn = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body ?? '{}') });
    const r = replies.shift();
    if (!r) throw new Error('no more scripted replies');
    const status = r.status ?? 200;
    return { ok: status < 300, status, json: async () => r.body };
  };
  return { fetch, seen };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aip-loop-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function build(replies: Reply[], over: Partial<BuildTask> = {}, opts: { maxBudgetUsd?: number; runShell?: ShellFn; maxTurns?: number } = {}) {
  const s = scripted(replies);
  const calls: string[] = [];
  const steps: string[] = [];
  const adapter = createClaudeLoopAdapter({ apiKey: KEY, prices: PRICES, fetch: s.fetch, sleep: async () => {}, ...opts });
  const task: BuildTask = {
    model: MODEL,
    prompt: 'do it',
    cwd: root,
    async checkTool(name) {
      calls.push(name);
      return { allow: true };
    },
    onStep: (t) => steps.push(t),
    ...over,
  };
  return { run: () => adapter.build!(task), seen: s.seen, calls, steps };
}

describe('own build loop', () => {
  it('runs the tools the model asks for, checks each one first, and returns the final answer with tokens and cost', async () => {
    await writeFile(join(root, 'a.txt'), 'one\ntwo\n');
    const b = build([tool('Read', { file_path: 'a.txt' }), text('All done.', { input_tokens: 200, output_tokens: 20 })]);
    const out = await b.run();
    expect(out.text).toBe('All done.');
    expect(b.calls).toEqual(['Read']);
    expect(b.steps).toEqual(['Read a.txt']);
    expect(out.usage.inputTokens).toBe(300);
    expect(out.usage.outputTokens).toBe(30);
    expect(out.usage.costUsd).toBeCloseTo((300 * 3 + 30 * 15) / 1e6, 10);
    // The second request carries the file contents as the tool's answer.
    const result = b.seen[1]!.body.messages.at(-1).content[0];
    expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
    expect(result.content).toBe('1\tone\n2\ttwo');
  });

  it('sends the key only in the header, offers the six tools and sets two cache breakpoints', async () => {
    const b = build([text('ok')]);
    await b.run();
    const r = b.seen[0]!;
    expect(r.url).toBe('https://api.anthropic.com/v1/messages');
    expect(r.headers['x-api-key']).toBe(KEY);
    expect(JSON.stringify(r.body)).not.toContain(KEY);
    expect(r.body.tools.map((t: { name: string }) => t.name)).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);
    expect(JSON.stringify(r.body).split('cache_control').length - 1).toBe(2);
  });

  it('a refused call is not run: the reason goes back to the model and nothing changes', async () => {
    const b = build([tool('Write', { file_path: 'evil.txt', content: 'x' }), text('ok')], {
      async checkTool() {
        return { allow: false, reason: 'pushing code needs the owner’s OK' };
      },
    });
    await b.run();
    await expect(readFile(join(root, 'evil.txt'))).rejects.toThrow();
    const result = b.seen[1]!.body.messages.at(-1).content[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toBe('pushing code needs the owner’s OK');
  });

  it('Edit needs exactly one match unless replace_all, and Write creates folders', async () => {
    await writeFile(join(root, 'f.txt'), 'a a b');
    const b = build([
      tool('Edit', { file_path: 'f.txt', old_string: 'a', new_string: 'z' }, 't1'),
      tool('Edit', { file_path: 'f.txt', old_string: 'b', new_string: 'y' }, 't2'),
      tool('Write', { file_path: 'sub/dir/n.txt', content: 'hi' }, 't3'),
      text('ok'),
    ]);
    await b.run();
    expect(b.seen[1]!.body.messages.at(-1).content[0].content).toContain('appears 2 times');
    expect(await readFile(join(root, 'f.txt'), 'utf8')).toBe('a a y');
    expect(await readFile(join(root, 'sub', 'dir', 'n.txt'), 'utf8')).toBe('hi');
  });

  it('Glob and Grep search the project and skip node_modules', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'const needle = 1;\n');
    await writeFile(join(root, 'node_modules', 'x', 'b.ts'), 'needle\n');
    const b = build([tool('Glob', { pattern: '**/*.ts' }, 't1'), tool('Grep', { pattern: 'needle' }, 't2'), text('ok')]);
    await b.run();
    expect(b.seen[1]!.body.messages.at(-1).content[0].content).toBe('src/a.ts');
    expect(b.seen[2]!.body.messages.at(-1).content[0].content).toBe('src/a.ts:1:const needle = 1;');
  });

  it('refuses paths outside the project copy: .., absolute paths and links', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'aip-outside-'));
    try {
      await writeFile(join(outside, 'secret.txt'), 'secret');
      await symlink(outside, join(root, 'link'), 'junction');
      await expect(insideRoot(root, '../x')).rejects.toThrow('outside the project copy');
      await expect(insideRoot(root, join(outside, 'secret.txt'))).rejects.toThrow('outside the project copy');
      await expect(insideRoot(root, 'link/secret.txt')).rejects.toThrow('outside the project copy');
      await expect(insideRoot(root, 'link/new.txt')).rejects.toThrow('outside the project copy');
      await expect(insideRoot(root, 'fine/new.txt')).resolves.toContain('new.txt');
      const b = build([tool('Read', { file_path: 'link/secret.txt' }), text('ok')]);
      await b.run();
      const r = b.seen[1]!.body.messages.at(-1).content[0];
      expect(r.is_error).toBe(true);
      expect(r.content).not.toContain('secret');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('runs commands in the project with the sandbox home and without the API key', async () => {
    let got: { command: string; cwd: string; env: Record<string, string> } | undefined;
    const runShell: ShellFn = async (command, o) => {
      got = { command, cwd: o.cwd, env: o.env };
      return { code: 1, output: 'boom' };
    };
    const b = build([tool('Bash', { command: 'pnpm test' }), text('ok')], { sandbox: { home: join(root, 'home') } }, { runShell });
    await b.run();
    expect(got!.command).toBe('pnpm test');
    expect(got!.cwd).toBe(root);
    expect(got!.env.HOME).toBe(join(root, 'home'));
    expect(got!.env.GIT_CONFIG_GLOBAL).toBe(join(root, 'home', '.gitconfig'));
    expect(JSON.stringify(got!.env)).not.toContain(KEY);
    expect(got!.env.ANTHROPIC_API_KEY).toBeUndefined();
    const r = b.seen[1]!.body.messages.at(-1).content[0];
    expect(r.is_error).toBe(true);
    expect(r.content).toContain('[exit code 1]');
  });

  it('really runs a command in the project folder with the default shell', async () => {
    await writeFile(join(root, 'marker.txt'), 'x');
    const b = build([tool('Bash', { command: 'echo hello && ls' }), text('ok')]);
    await b.run();
    const out = b.seen[1]!.body.messages.at(-1).content[0];
    expect(out.is_error).toBeUndefined();
    expect(out.content).toContain('hello');
    expect(out.content).toContain('marker.txt');
  });

  it('stops when the run passes its cost limit', async () => {
    const big = { input_tokens: 1_000_000, output_tokens: 0 };
    const b = build([tool('Glob', { pattern: '*' }, 't1', big), text('never')], {}, { maxBudgetUsd: 1 });
    await expect(b.run()).rejects.toThrow('cost limit');
    expect(failureCause('Stopped: this run would have gone over its cost limit.')).toBe('budget');
    expect(b.seen).toHaveLength(1);
  });

  it('will not start without a price for the model, and spends nothing', async () => {
    const s = scripted([text('x')]);
    const adapter = createClaudeLoopAdapter({ apiKey: KEY, prices: {}, fetch: s.fetch });
    await expect(adapter.build!({ model: MODEL, prompt: 'p', cwd: root, checkTool: async () => ({ allow: true }) })).rejects.toThrow('Set the price');
    expect(s.seen).toHaveLength(0);
  });

  it('ends after its turn limit, counted as the model’s own failure', async () => {
    const replies = Array.from({ length: 5 }, (_, i) => tool('Glob', { pattern: '*' }, `t${i}`));
    const b = build(replies, {}, { maxTurns: 3 });
    const err = await b.run().catch((e: Error) => e);
    expect((err as Error).message).toContain('max turns: 3');
    expect(failureCause((err as Error).message)).toBe('model');
    expect(b.seen).toHaveLength(3);
  });

  it('stops at once when the stop signal is set', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const b = build([text('x')], { signal: ctl.signal });
    await expect(b.run()).rejects.toThrow('Stopped.');
    expect(b.seen).toHaveLength(0);
  });

  it('retries a busy provider, explains a bad key, and never shows the key', async () => {
    const ok = build([{ status: 529, body: { error: { message: 'overloaded' } } }, text('fine')]);
    await expect(ok.run()).resolves.toMatchObject({ text: 'fine' });
    expect(ok.seen).toHaveLength(2);
    const bad = build([{ status: 401, body: { error: { message: `invalid x-api-key ${KEY}` } } }]);
    const err = (await bad.run().catch((e: Error) => e)) as Error;
    expect(err.message).toBe('Claude did not accept the API key. Check it in Settings.');
    const odd = build([{ status: 400, body: { error: { message: `bad request for ${KEY}` } } }]);
    const err2 = (await odd.run().catch((e: Error) => e)) as Error;
    expect(err2.message).not.toContain(KEY);
  });

  it('plain asks (no tools) return the text, tokens and cost', async () => {
    const s = scripted([text('hello', { input_tokens: 10, output_tokens: 5 })]);
    const adapter = createClaudeLoopAdapter({ apiKey: KEY, prices: PRICES, fetch: s.fetch });
    const out = await adapter.run({ job: 'read', prompt: 'hi', model: MODEL });
    expect(out.text).toBe('hello');
    expect(out.usage.inputTokens).toBe(10);
    expect(s.seen[0]!.body.tools).toBeUndefined();
  });
});

describe('helpers', () => {
  it('prices cached input at a tenth and cache writes at 1.25 times', () => {
    const c = replyCostUsd(MODEL, { input_tokens: 1000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 800, output_tokens: 100 }, PRICES);
    expect(c).toBeCloseTo(((1000 + 1000 + 1000) * 3 + 100 * 15) / 1e6, 10);
    expect(replyCostUsd('unknown-model', { input_tokens: 1 }, PRICES)).toBeNull();
  });

  it('matches globs', () => {
    const m = (p: string, f: string) => globToRegExp(p).test(f);
    expect(m('**/*.ts', 'a.ts')).toBe(true);
    expect(m('**/*.ts', 'src/deep/a.ts')).toBe(true);
    expect(m('src/*.ts', 'src/deep/a.ts')).toBe(false);
    expect(m('a?.js', 'ab.js')).toBe(true);
    expect(m('*.ts', 'a.tsx')).toBe(false);
  });
});

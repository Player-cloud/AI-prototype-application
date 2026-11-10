import { describe, expect, it } from 'vitest';
import { claudeEnv, createClaudeAdapter, friendlyError, modelName, redact, type QueryFn, type SdkMessage } from '../src/index.js';

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

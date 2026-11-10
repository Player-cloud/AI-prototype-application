import { describe, expect, it } from 'vitest';
import { BASE_URL, costFromPrices, createOpenAICompatibleAdapter, pickModel, type FetchFn } from '../src/index.js';

// Obviously fake test value, not a real key.
const FAKE_KEY = 'sk-test-0000000000000000';

type Call = { url: string; init: { method: string; headers: Record<string, string>; body?: string } };

function fakeFetch(status: number, body: unknown, calls: Call[] = []): FetchFn {
  return async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

const answer = { choices: [{ message: { content: 'ready' } }], usage: { prompt_tokens: 12, completion_tokens: 1 } };

describe('OpenAI-compatible adapter', () => {
  it('sends one chat message to the right address with the key as a bearer token', async () => {
    const calls: Call[] = [];
    const a = createOpenAICompatibleAdapter({ provider: 'deepseek', apiKey: FAKE_KEY, fetch: fakeFetch(200, answer, calls) });
    const out = await a.run({ job: 'read', prompt: 'hi', model: 'deepseek-chat' });
    expect(out).toEqual({ text: 'ready', usage: { inputTokens: 12, outputTokens: 1, costUsd: null } });
    expect(calls[0]!.url).toBe(`${BASE_URL.deepseek}/chat/completions`);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] });
  });

  it('works out the cost when a price is set', async () => {
    const a = createOpenAICompatibleAdapter({
      provider: 'openai',
      apiKey: FAKE_KEY,
      prices: { m: { inputPerM: 1, outputPerM: 10 } },
      fetch: fakeFetch(200, answer),
    });
    const out = await a.run({ job: 'read', prompt: 'hi', model: 'm' });
    expect(out.usage.costUsd).toBeCloseTo(0.000022);
  });

  it('checks a key with the free models list', async () => {
    const calls: Call[] = [];
    const a = createOpenAICompatibleAdapter({ provider: 'openai', apiKey: FAKE_KEY, fetch: fakeFetch(200, { data: [] }, calls) });
    await a.checkKey!();
    expect(calls[0]!.url).toBe(`${BASE_URL.openai}/models`);
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it('gives plain errors and never shows the key', async () => {
    const run = (status: number, body: unknown) =>
      createOpenAICompatibleAdapter({ provider: 'openai', apiKey: FAKE_KEY, fetch: fakeFetch(status, body) })
        .run({ job: 'read', prompt: 'hi', model: 'm' })
        .catch((e: Error) => e.message);
    expect(await run(401, {})).toBe('OpenAI did not accept the API key. Check it in Settings.');
    expect(await run(402, {})).toBe('Your OpenAI account has no credit left.');
    expect(await run(429, {})).toContain('too many requests');
    expect(await run(404, { error: { message: `no model; key ${FAKE_KEY}` } })).toBe('OpenAI error 404: no model; key [key hidden]');
    expect(await run(200, { choices: [] })).toBe('OpenAI sent an answer without text.');
  });

  it('reports a network failure plainly', async () => {
    const failing: FetchFn = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    const a = createOpenAICompatibleAdapter({ provider: 'deepseek', apiKey: FAKE_KEY, fetch: failing });
    await expect(a.checkKey!()).rejects.toThrow('Could not reach DeepSeek');
  });

  it('needs a key', () => {
    expect(() => createOpenAICompatibleAdapter({ provider: 'deepseek', apiKey: '' })).toThrow('No DeepSeek API key saved');
  });
});

describe('pickModel', () => {
  it('uses the strong model for planning and reviews and the cheap one otherwise', () => {
    expect(pickModel('deepseek', 'plan')).toBe('deepseek-reasoner');
    expect(pickModel('deepseek', 'read')).toBe('deepseek-chat');
    expect(pickModel('openai', 'security-review')).toBe('gpt-5');
    expect(pickModel('openai', 'build')).toBe('gpt-5-mini');
    expect(pickModel('claude', 'read')).toBe('claude-haiku-5-5');
    expect(pickModel('claude', 'code-review', { sensitive: true })).toBe('claude-sonnet-5-5');
  });

  it('works out cost from a price table, or null when unknown', () => {
    expect(costFromPrices('x', 1_000_000, 0, { x: { inputPerM: 2, outputPerM: 8 } })).toBe(2);
    expect(costFromPrices('y', 10, 10, {})).toBeNull();
  });
});

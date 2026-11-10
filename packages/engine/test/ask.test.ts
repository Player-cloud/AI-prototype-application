import { describe, expect, it } from 'vitest';
import type { ModelAdapter } from '@aip/models';
import { costText, handleLine, type Deps } from '../src/protocol.ts';

// Obviously fake test value, not a real key.
const FAKE_KEY = 'sk-ant-test-0000000000000000';

function fakeDeps(run: ModelAdapter['run'], seen: { provider?: string; key?: string } = {}, checkKey?: ModelAdapter['checkKey']): Deps {
  return {
    async makeAdapter(provider, apiKey) {
      seen.provider = provider;
      seen.key = apiKey;
      return checkKey ? { provider, run, checkKey } : { provider, run };
    },
    async pickModel(_provider, job) {
      return job === 'read' ? 'claude-haiku-5-5' : 'claude-opus-5-5';
    },
    async modelName(id) {
      return id === 'claude-haiku-5-5' ? 'Haiku 5.5' : 'Opus 5.5';
    },
  };
}

const askLine = (params: Record<string, unknown>) => JSON.stringify({ id: 5, method: 'ask', params });

describe('ask', () => {
  it('picks the model for the job and returns text, tokens and cost in £ and $', async () => {
    const seen: { provider?: string; key?: string } = {};
    const deps = fakeDeps(async (t) => ({ text: `echo ${t.prompt} via ${t.model}`, usage: { inputTokens: 9, outputTokens: 3, costUsd: 2 } }), seen);
    const reply = JSON.parse(await handleLine(askLine({ provider: 'claude', apiKey: FAKE_KEY, job: 'read', prompt: 'hi' }), deps));
    expect(reply).toEqual({
      id: 5,
      result: {
        text: 'echo hi via claude-haiku-5-5',
        model: 'claude-haiku-5-5',
        modelName: 'Haiku 5.5',
        inputTokens: 9,
        outputTokens: 3,
        costUsd: 2,
        costText: '£1.58 ($2.00)',
      },
    });
    expect(seen).toEqual({ provider: 'claude', key: FAKE_KEY });
    expect(JSON.stringify(reply)).not.toContain(FAKE_KEY);
  });

  it('checks its inputs', async () => {
    const deps = fakeDeps(async () => ({ text: '', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }));
    const err = async (params: Record<string, unknown>) => JSON.parse(await handleLine(askLine(params), deps)).error;
    expect(await err({ provider: 'claude', job: 'read', prompt: 'hi' })).toBe('apiKey is required');
    expect(await err({ provider: 'gemini', apiKey: FAKE_KEY, job: 'read', prompt: 'hi' })).toBe('unknown provider: gemini');
    expect(await err({ provider: 'claude', apiKey: FAKE_KEY, job: 'dance', prompt: 'hi' })).toBe('unknown job: dance');
    expect(await err({ provider: 'claude', apiKey: FAKE_KEY, job: 'read', prompt: '' })).toBe('prompt is required');
    expect(JSON.parse(await handleLine('{"id":1,"method":"ask"}', deps)).error).toBe('params must be an object');
  });

  it('never sends the key back inside an error', async () => {
    const deps = fakeDeps(async () => {
      throw new Error(`bad key ${FAKE_KEY}`);
    });
    const line = await handleLine(askLine({ provider: 'claude', apiKey: FAKE_KEY, job: 'read', prompt: 'hi' }), deps);
    expect(line).not.toContain(FAKE_KEY);
    expect(JSON.parse(line).error).toBe('bad key [key hidden]');
  });

  it('shows tiny costs as under a penny', () => {
    expect(costText(0.0004)).toBe('under £0.01 (under $0.01)');
    expect(costText(1)).toBe('£0.79 ($1.00)');
    expect(costText(null)).toBe('cost unknown (prices are set in Settings, step 4c)');
  });
});

const checkLine = (params: Record<string, unknown>) => JSON.stringify({ id: 6, method: 'check', params });

describe('check', () => {
  it('uses the free key check when the provider has one, and runs no model', async () => {
    let ran = false;
    let checked = false;
    const seen: { provider?: string } = {};
    const deps = fakeDeps(
      async () => {
        ran = true;
        return { text: '', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
      },
      seen,
      async () => {
        checked = true;
      },
    );
    const reply = JSON.parse(await handleLine(checkLine({ provider: 'deepseek', apiKey: FAKE_KEY }), deps));
    expect(reply.result).toEqual({ ok: true, summary: 'Connected. DeepSeek accepted the key. This check is free.' });
    expect({ ran, checked, provider: seen.provider }).toEqual({ ran: false, checked: true, provider: 'deepseek' });
  });

  it('asks Claude for one word when there is no free check', async () => {
    const deps = fakeDeps(async () => ({ text: ' ready\n', usage: { inputTokens: 9, outputTokens: 1, costUsd: 0.0004 } }));
    const reply = JSON.parse(await handleLine(checkLine({ provider: 'claude', apiKey: FAKE_KEY }), deps));
    expect(reply.result.summary).toBe('Connected. Haiku 5.5 replied “ready”. Cost: under £0.01 (under $0.01).');
  });

  it('passes on a rejected key without the key in it', async () => {
    const deps = fakeDeps(
      async () => ({ text: '', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }),
      {},
      async () => {
        throw new Error(`OpenAI did not accept ${FAKE_KEY}`);
      },
    );
    const line = await handleLine(checkLine({ provider: 'openai', apiKey: FAKE_KEY }), deps);
    expect(JSON.parse(line).error).toBe('OpenAI did not accept [key hidden]');
  });
});

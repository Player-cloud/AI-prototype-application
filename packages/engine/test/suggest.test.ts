import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelAdapter } from '@aip/models';
import { applyPatch, newInterview } from '../src/interview.ts';
import { parseSuggestions, suggestPrompt } from '../src/suggest.ts';
import { handleLine, type Deps } from '../src/protocol.ts';

// Obviously fake test value, not a real key.
const FAKE_KEY = 'sk-ant-test-0000000000000000';
const NOW = new Date('2026-11-11T15:00:00Z');

const base = () =>
  applyPatch(newInterview('Club HR', 'club-hr', NOW), {
    text: { 'idea.what': 'HR for a sports club' },
    features: [{ name: 'Login', what: 'Email sign in' }],
    done: { 'F-01': ['A member can sign in'] },
  });

describe('the planning prompt', () => {
  it('is short, carries the answers so far and asks for JSON only', () => {
    const p = suggestPrompt(base(), 'features');
    expect(p).toContain('Project: Club HR');
    expect(p).toContain('- The idea / What is it, in a sentence or two? HR for a sports club');
    expect(p).toContain('- Features: F-01 Login (Email sign in)');
    expect(p).toContain('"features": [{"name": "...", "what": "..."}]');
    expect(p.endsWith('Reply with the JSON only.')).toBe(true);
    expect(p.length).toBeLessThan(1500);
  });
});

describe('reading Claude’s ideas', () => {
  it('keeps only new features, real areas and checks for real features', () => {
    const iv = base();
    const f = parseSuggestions(
      'Sure! {"questions": ["Who signs up members?", 5], "features": [{"name": "login"}, {"name": "Rota", "what": "Weekly shifts"}, {"what": "no name"}]}',
      iv,
      'features',
    );
    expect(f).toEqual({ questions: ['Who signs up members?'], areas: [], features: [{ name: 'Rota', what: 'Weekly shifts' }], done: {} });

    const a = parseSuggestions('{"areas": ["Payments", "Moon landing", "Logins and accounts"]}', iv, 'checklist');
    expect(a.areas).toEqual(['Logins and accounts', 'Payments']);

    const d = parseSuggestions('{"done": {"F-01": ["A member can sign in", "A wrong password shows an error"], "F-09": ["x"]}}', iv, 'done');
    expect(d.done).toEqual({ 'F-01': ['A wrong password shows an error'] });
  });

  it('says so plainly when the reply isn’t JSON', () => {
    expect(() => parseSuggestions('I would suggest a login page.', base(), 'idea')).toThrow('wasn’t in the expected shape');
    expect(() => parseSuggestions('{not json}', base(), 'idea')).toThrow('wasn’t in the expected shape');
  });
});

describe('interview_suggest', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aip-suggest-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('asks the planning model and returns ideas with the cost, saving nothing', async () => {
    const seen: { job?: string; model?: string; prompt?: string } = {};
    const run: ModelAdapter['run'] = async (t) => {
      Object.assign(seen, { job: t.job, model: t.model, prompt: t.prompt });
      return { text: '{"questions": ["Do coaches log in too?"]}', usage: { inputTokens: 400, outputTokens: 40, costUsd: 0.02 } };
    };
    const deps: Deps = {
      async makeAdapter(provider) {
        return { provider, run };
      },
      async pickModel(_p, job) {
        return job === 'plan' ? 'claude-opus-5-5' : 'claude-haiku-5-5';
      },
      async modelName() {
        return 'Opus 5.5';
      },
      now: () => NOW,
    };
    const call = async (method: string, params: Record<string, unknown>) =>
      JSON.parse(await handleLine(JSON.stringify({ id: 1, method, params }), deps)) as { result?: any; error?: string };

    const settings = { dataFolder: dir };
    await call('interview_start', { settings, name: 'Club HR' });
    const dbPath = join(dir, 'history.sqlite');
    const r = await call('interview_suggest', { settings, slug: 'club-hr', stage: 'audience', provider: 'claude', apiKey: FAKE_KEY, dbPath });
    expect(r.error).toBeUndefined();
    expect(r.result).toEqual({
      suggestions: { questions: ['Do coaches log in too?'], areas: [], features: [], done: {} },
      modelName: 'Opus 5.5',
      costText: '£0.02 ($0.02)',
    });
    expect(seen).toMatchObject({ job: 'plan', model: 'claude-opus-5-5' });
    expect(seen.prompt).toContain('Stage now: Who it’s for and goals.');

    // The cost counts against this month's budget.
    const spend = (await call('spend_summary', { settings, dbPath })).result;
    expect(spend.calls).toBe(1);

    // Nothing was added to the plan.
    expect((await call('interview_get', { settings, slug: 'club-hr' })).result.interview.text).toEqual({});
    // And the key never comes back in an error.
    const bad = await call('interview_suggest', { settings, slug: 'nope', stage: 'idea', provider: 'claude', apiKey: FAKE_KEY, dbPath });
    expect(bad.error).toBe('There’s no project called “nope”.');
  });
});

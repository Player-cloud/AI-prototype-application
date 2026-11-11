import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelAdapter } from '@aip/models';
import { applyPatch, newInterview } from '../src/interview.ts';
import { FRESH_EYES, parseFindings, renderReview, reviewPrompt, reviewersFor, specText } from '../src/review.ts';
import { handleLine, type Deps } from '../src/protocol.ts';

// Obviously fake test value, not a real key.
const FAKE_KEY = 'sk-ant-test-0000000000000000';
const NOW = new Date('2026-11-11T16:00:00Z');

describe('plan review rules', () => {
  it('gives every plan one review, and big plans three fresh-eyes reviewers', () => {
    expect(reviewersFor(false).map((r) => r.id)).toEqual(['plan']);
    expect(reviewersFor(true).map((r) => r.id)).toEqual(['users', 'features', 'risk']);
  });

  it('shows a reviewer only the spec and done files', () => {
    const iv = applyPatch(newInterview('Club HR', 'club-hr', NOW), { features: [{ name: 'Login' }], done: { 'F-01': ['Can sign in'] } });
    const spec = specText(iv, NOW);
    expect(spec).toContain('=== spec.md ===');
    expect(spec).toContain('=== done/F-01.md ===\n# F-01 Login: done when');
    const p = reviewPrompt(spec, FRESH_EYES[2]!);
    expect(p).toContain('Look only at logins, payments, personal data and security');
    expect(p).toContain('You have not seen how it was made.');
  });

  it('reads findings, dropping bad ones and unknown feature IDs', () => {
    const f = parseFindings(
      '{"findings": [{"severity": "must", "text": "No password reset", "feature": "F-01"}, {"severity": "huge", "text": "Odd"}, {"text": ""}, {"severity": "could", "text": "x", "feature": "F-99"}]}',
      'risk',
      ['F-01'],
    );
    expect(f).toEqual([
      { reviewer: 'risk', severity: 'must', text: 'No password reset', feature: 'F-01' },
      { reviewer: 'risk', severity: 'should', text: 'Odd' },
      { reviewer: 'risk', severity: 'could', text: 'x' },
    ]);
    expect(() => parseFindings('Looks fine to me.', 'plan', [])).toThrow('wasn’t in the expected shape');
  });

  it('writes review.md with the most serious first', () => {
    const iv = newInterview('Club HR', 'club-hr', NOW);
    const md = renderReview(iv, [
      { reviewer: 'plan', severity: 'could', text: 'Dark mode' },
      { reviewer: 'plan', severity: 'must', text: 'No password reset', feature: 'F-01' },
    ], false, '£0.02 ($0.03)', NOW);
    expect(md).toBe(
      '# Club HR: plan review\n\nReviewed on 2026-11-11 by one plan review. Cost: £0.02 ($0.03).\n\n- **Must fix** (F-01): No password reset\n- **Could add**: Dark mode\n',
    );
  });
});

describe('interview_review', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aip-review-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function deps(prompts: string[]): Deps {
    const run: ModelAdapter['run'] = async (t) => {
      prompts.push(`${t.job}|${t.model}|${t.prompt}`);
      return { text: '{"findings": [{"severity": "must", "text": "No password reset", "feature": "F-01"}]}', usage: { inputTokens: 900, outputTokens: 60, costUsd: 0.01 } };
    };
    return {
      async makeAdapter(provider) {
        return { provider, run };
      },
      async pickModel(_p, job) {
        return job === 'plan-review' ? 'claude-sonnet-5-5' : 'claude-opus-5-5';
      },
      async modelName() {
        return 'Sonnet 5.5';
      },
      now: () => NOW,
    };
  }

  async function finishedPlan(call: (m: string, p: Record<string, unknown>) => Promise<any>, settings: Record<string, unknown>, features: string[], areas: string[] = []) {
    await call('interview_start', { settings, name: 'Club HR' });
    const patches: Record<string, Record<string, unknown>> = {
      idea: { text: { 'idea.what': 'HR' } },
      audience: { text: { 'audience.who': 'Staff', 'audience.goals': 'Shifts' } },
      features: { features: features.map((name) => ({ name })) },
      checklist: { areas },
      look: { text: { 'look.feel': 'Calm' } },
      tech: {},
      done: { done: Object.fromEntries(features.map((_, i) => [`F-0${i + 1}`, ['Works']])) },
    };
    for (const [stage, patch] of Object.entries(patches)) {
      await call('interview_save', { settings, slug: 'club-hr', stage, patch });
      await call('interview_confirm', { settings, slug: 'club-hr', stage });
    }
  }

  it('needs a finished interview', async () => {
    const prompts: string[] = [];
    const call = async (method: string, params: Record<string, unknown>) =>
      JSON.parse(await handleLine(JSON.stringify({ id: 1, method, params }), deps(prompts)));
    const settings = { dataFolder: dir };
    await call('interview_start', { settings, name: 'Club HR' });
    const r = await call('interview_review', { settings, slug: 'club-hr', provider: 'claude', apiKey: FAKE_KEY });
    expect(r.error).toBe('Finish the interview first: the review reads the spec.');
    expect(prompts).toEqual([]);
  });

  it('runs one plan review for a small plan and saves review.md', async () => {
    const prompts: string[] = [];
    const call = async (method: string, params: Record<string, unknown>) =>
      JSON.parse(await handleLine(JSON.stringify({ id: 1, method, params }), deps(prompts)));
    const settings = { dataFolder: dir };
    await finishedPlan(call, settings, ['Login']);
    const before = (await call('interview_get', { settings, slug: 'club-hr' })).result;
    expect(before).toMatchObject({ reviewers: 1, reviewCost: 'costs up to £0.40 ($0.50)', reviewCurrent: false });

    const r = (await call('interview_review', { settings, slug: 'club-hr', provider: 'claude', apiKey: FAKE_KEY, dbPath: join(dir, 'h.sqlite') })).result;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/^plan-review\|claude-sonnet-5-5\|/);
    expect(r.summary).toMatch(/^1 finding, 1 must fix\. Cost: £0\.01 \(\$0\.01\)\. Saved here, but not synced yet/);
    expect(r.view.reviewCurrent).toBe(true);
    expect(await readFile(join(dir, 'projects', 'club-hr', 'review.md'), 'utf8')).toContain('- **Must fix** (F-01): No password reset');

    // Changing the plan makes the review out of date.
    await call('interview_save', { settings, slug: 'club-hr', stage: 'done', patch: { done: { 'F-01': ['Works', 'Also this'] } } });
    const again = (await call('interview_confirm', { settings, slug: 'club-hr', stage: 'done' })).result;
    expect(again.view.reviewCurrent).toBe(false);
  });

  it('runs three separate fresh-eyes reviewers for a big plan', async () => {
    const prompts: string[] = [];
    const call = async (method: string, params: Record<string, unknown>) =>
      JSON.parse(await handleLine(JSON.stringify({ id: 1, method, params }), deps(prompts)));
    const settings = { dataFolder: dir };
    await finishedPlan(call, settings, ['Login'], ['Payments']);
    expect((await call('interview_get', { settings, slug: 'club-hr' })).result).toMatchObject({ big: true, reviewers: 3, reviewCost: 'costs up to £1.19 ($1.50)' });
    const r = (await call('interview_review', { settings, slug: 'club-hr', provider: 'claude', apiKey: FAKE_KEY })).result;
    expect(prompts).toHaveLength(3);
    expect(prompts.every((p) => p.includes('You have not seen how it was made.'))).toBe(true);
    expect(r.summary).toMatch(/^3 findings, 3 must fix\. Cost: £0\.02 \(\$0\.03\)/);
    expect(r.view.interview.review.findings.map((f: { reviewer: string }) => f.reviewer)).toEqual(['users', 'features', 'risk']);
  });
});

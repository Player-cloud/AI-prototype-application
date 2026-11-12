import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunLog, type WorkflowStats } from '@aip/memory';
import { CONFIDENCE, adviceFor, confidenceLevel, shortDate, workflowAdvice, workflowConfidence, workflowText } from '../src/workflows.ts';
import { handleLine } from '../src/protocol.ts';

const NAMES: Record<string, string> = { a: 'Sonnet 5.5', b: 'Opus 5.5' };
const nameOf = (id: string) => NAMES[id] ?? id;

const NOW = new Date('2026-11-12T12:00:00Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

const stats = (model: string, kept: number, undone: number, extra: Partial<WorkflowStats> = {}): WorkflowStats => ({
  model,
  finished: kept + undone,
  kept,
  undone,
  waiting: 0,
  failed: 0,
  notCounted: 0,
  testsFirstTime: kept,
  defects: undone,
  safetyFailures: 0,
  costUsd: 0.1 * (kept + undone),
  costPerKeptUsd: kept ? (0.1 * (kept + undone)) / kept : null,
  avgMs: 150_000,
  rating: null,
  rated: 0,
  lastAt: '2026-11-12T10:00:00Z',
  ...extra,
});

describe('workflow comparisons feed the engine’s picks (CI-4)', () => {
  it('shows failed builds, counted only for the model’s fault, and doesn’t change the advice', () => {
    expect(workflowText(stats('a', 2, 0, { failed: 1, notCounted: 2 }), 'Sonnet 5.5', 0.79)).toContain('1 failed (the model’s or tool’s fault), 2 ended early for another reason (not counted)');
    // Only failures: it is not "untested".
    expect(workflowAdvice('a', [stats('a', 0, 0, { failed: 1, testsFirstTime: 0, defects: 0 })], nameOf, 0.79)[0]).toMatch(/^Low confidence \(1 build, last 12 Nov\): Evidence: Sonnet 5.5: no build kept or undone yet, 1 failed/);
    expect(workflowAdvice('a', [stats('a', 1, 3, { failed: 5 }), stats('b', 4, 0)], nameOf, 0.79)).toHaveLength(3);
  });

  it('says plainly when a way of building is untested, or only a first look', () => {
    expect(workflowAdvice('a', [], nameOf, 0.79)).toEqual(['No builds with Sonnet 5.5 yet, so this way of building is untested.']);
    expect(workflowAdvice('a', [stats('a', 1, 0), stats('b', 5, 0)], nameOf, 0.79, NOW)).toEqual([
      'Low confidence (1 build, last 12 Nov): Evidence: Sonnet 5.5: 1 of 1 builds kept, tests passed first time in 1 of 1, 0 problems found by the app’s checks, £0.08 ($0.10) per kept build, about 3 min each. A first look, not proof.',
      'Low confidence: 1 build counted, last build 12 Nov 2026, 0 failed (model or tool fault), 0 not counted, £0.08 ($0.10) per kept build (failed builds included).',
    ]);
  });

  it('suggests another way only when it clearly did better over enough builds, and never changes the pick', () => {
    const better = workflowAdvice('a', [stats('a', 1, 3), stats('b', 4, 0)], nameOf, 0.79, NOW);
    expect(better[2]).toBe(
      'Suggestion: Opus 5.5 kept more builds (4 of 4, against 1 of 4). The app still uses Sonnet 5.5, because the model for each job is your choice. Change it only if you agree.',
    );
    // Close results: the simplest way that works stays, with no suggestion.
    expect(workflowAdvice('a', [stats('a', 5, 1), stats('b', 4, 0)], nameOf, 0.79)).toHaveLength(2);
    // Too few builds for the other way.
    expect(workflowAdvice('a', [stats('a', 1, 3), stats('b', 2, 0)], nameOf, 0.79)).toHaveLength(2);
    // A safety failure is never outweighed by a better score.
    expect(workflowAdvice('a', [stats('a', 1, 3), stats('b', 4, 0, { safetyFailures: 1 })], nameOf, 0.79)).toHaveLength(2);
  });

  it('writes each way in plain words with £ and $, and says what wasn’t recorded', () => {
    expect(workflowText(stats('a', 0, 0, { waiting: 1, costUsd: null, costPerKeptUsd: null, avgMs: null, testsFirstTime: 0, defects: 0 }), 'Sonnet 5.5', 0.79)).toBe(
      'Sonnet 5.5: no build kept or undone yet, 1 waiting, tests passed first time in 0 of 1, 0 problems found by the app’s checks, cost not recorded, time not recorded. A first look, not proof.',
    );
    expect(workflowText(stats('a', 2, 1, { safetyFailures: 1, rating: 4.5, rated: 2, avgMs: 30_000 }), 'Sonnet 5.5', 0.79)).toBe(
      'Sonnet 5.5: 2 of 3 builds kept, 1 undone, tests passed first time in 2 of 3, 1 problem found by the app’s checks, the secret scan found something in 1, £0.12 ($0.15) per kept build, under a minute each, your rating 4.5 (2 rated).',
    );
  });

  it('reads real builds from the history file, and is on the protocol as workflow_compare', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aip-wf-'));
    try {
      const dbPath = join(dir, 'history.sqlite');
      expect(await adviceFor(undefined, 'claude-sonnet-5-5', async (id) => id, 0.79)).toEqual([]);
      const log = RunLog.open(dbPath);
      const id = log.add({ at: new Date(), slug: 's', feature: 'F-01', path: 'p', branch: 'b', base: 'c', model: 'claude-sonnet-5-5', costUsd: 0.2, testsPassed: true, fixAttempts: 0, summary: '', ms: 90_000 });
      log.decide(id, 'kept', new Date());
      log.close();
      const advice = await adviceFor(dbPath, 'claude-sonnet-5-5', async () => 'Sonnet 5.5', 0.79);
      expect(advice[0]).toMatch(/^Low confidence \(1 build, last \d+ \w+\): Evidence: Sonnet 5\.5: 1 of 1 builds kept, .*£0\.16 \(\$0\.20\) per kept build, about 2 min each\. A first look, not proof\.$/);
      const out = JSON.parse((await handleLine(JSON.stringify({ id: 1, method: 'workflow_compare', params: { settings: {}, dbPath } })))!);
      expect(out.result).toMatchObject([{ model: 'claude-sonnet-5-5', name: 'Sonnet 5.5', kept: 1, finished: 1 }]);
      expect(out.result[0].text).toMatch(/^Sonnet 5\.5: 1 of 1 builds kept/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sets the confidence level from counted builds and age, with the edges tested', () => {
    expect(CONFIDENCE).toEqual({ lowBelow: 3, highAt: 10, staleDays: 30, freshDays: 14 });
    expect(confidenceLevel(2, 0)).toBe('low');
    expect(confidenceLevel(3, 0)).toBe('medium');
    expect(confidenceLevel(3, 30)).toBe('medium');
    expect(confidenceLevel(3, 30.01)).toBe('low');
    expect(confidenceLevel(9, 1)).toBe('medium');
    expect(confidenceLevel(10, 14)).toBe('high');
    expect(confidenceLevel(10, 14.01)).toBe('medium');
    expect(confidenceLevel(50, 31)).toBe('low');
    expect(confidenceLevel(50, Number.NaN)).toBe('low');
    // Counted = finished + failed by the model's fault; not-counted and waiting builds don't add.
    expect(workflowConfidence(stats('a', 1, 1, { failed: 1, notCounted: 9, waiting: 9, lastAt: ago(1) }), 0.79, NOW).level).toBe('medium');
    expect(workflowConfidence(stats('a', 1, 1, { notCounted: 9, lastAt: ago(1) }), 0.79, NOW).level).toBe('low');
    expect(workflowConfidence(stats('a', 8, 2, { lastAt: ago(14) }), 0.79, NOW).level).toBe('high');
    expect(workflowConfidence(stats('a', 8, 2, { lastAt: ago(15) }), 0.79, NOW).level).toBe('medium');
  });

  it('works out cost per kept build including failed builds, and says so when nothing is kept', () => {
    // £ and $: total $1.00 (including a failed build's cost) over 2 kept = $0.50 each.
    const c = workflowConfidence(stats('a', 2, 0, { failed: 1, costUsd: 1, costPerKeptUsd: 0.4, lastAt: ago(2) }), 0.8, NOW);
    expect(c.costPerKeptUsd).toBe(0.5);
    expect(c.text).toBe('Medium confidence: 3 builds counted, last build 10 Nov 2026, 1 failed (model or tool fault), 0 not counted, £0.40 ($0.50) per kept build (failed builds included).');
    const none = workflowConfidence(stats('a', 0, 2, { failed: 1, costUsd: 0.3, lastAt: ago(2) }), 0.8, NOW);
    expect(none.costPerKeptUsd).toBeNull();
    expect(none.text).toContain('no kept builds yet.');
  });

  it('shows dates in UTC so they match on every computer', () => {
    expect(shortDate('2026-11-03T23:59:59Z')).toBe('3 Nov');
    expect(shortDate('2026-11-04T00:00:00Z', true)).toBe('4 Nov 2026');
    expect(shortDate('2026-11-03T23:30:00-05:00')).toBe('4 Nov');
    expect(shortDate('')).toBe('');
    const saved = process.env.TZ;
    try {
      for (const tz of ['Pacific/Auckland', 'America/Los_Angeles']) {
        process.env.TZ = tz;
        expect(shortDate('2026-11-03T23:59:59Z')).toBe('3 Nov');
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it('never changes what is picked: low and high confidence give the same suggestion', () => {
    const lowStats = [stats('a', 1, 3, { lastAt: ago(90) }), stats('b', 4, 0, { lastAt: ago(90) })];
    const highStats = [stats('a', 3, 9, { lastAt: ago(1) }), stats('b', 10, 0, { lastAt: ago(1) })];
    const low = workflowAdvice('a', lowStats, nameOf, 0.79, NOW);
    const high = workflowAdvice('a', highStats, nameOf, 0.79, NOW);
    expect(low[0]).toMatch(/^Low confidence \(4 builds, last 14 Aug\):/);
    expect(high[0]).toMatch(/^High confidence \(12 builds, last 11 Nov\):/);
    for (const out of [low, high]) {
      expect(out.at(-1)).toMatch(/^Suggestion: Opus 5.5 kept more builds .*The app still uses Sonnet 5.5,/);
    }
    // Same answer whatever the clock says.
    expect(workflowAdvice('a', lowStats, nameOf, 0.79, new Date('2030-01-01T00:00:00Z')).at(-1)).toBe(low.at(-1));
  });
});

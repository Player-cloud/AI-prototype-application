import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunLog, type WorkflowStats } from '@aip/memory';
import { adviceFor, workflowAdvice, workflowText } from '../src/workflows.ts';
import { handleLine } from '../src/protocol.ts';

const NAMES: Record<string, string> = { a: 'Sonnet 5.5', b: 'Opus 5.5' };
const nameOf = (id: string) => NAMES[id] ?? id;

const stats = (model: string, kept: number, undone: number, extra: Partial<WorkflowStats> = {}): WorkflowStats => ({
  model,
  finished: kept + undone,
  kept,
  undone,
  waiting: 0,
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
  it('says plainly when a way of building is untested, or only a first look', () => {
    expect(workflowAdvice('a', [], nameOf, 0.79)).toEqual(['No builds with Sonnet 5.5 yet, so this way of building is untested.']);
    expect(workflowAdvice('a', [stats('a', 1, 0), stats('b', 5, 0)], nameOf, 0.79)).toEqual([
      'Evidence: Sonnet 5.5: 1 of 1 builds kept, tests passed first time in 1 of 1, 0 problems found by the app’s checks, £0.08 ($0.10) per kept build, about 3 min each. A first look, not proof.',
    ]);
  });

  it('suggests another way only when it clearly did better over enough builds, and never changes the pick', () => {
    const better = workflowAdvice('a', [stats('a', 1, 3), stats('b', 4, 0)], nameOf, 0.79);
    expect(better[1]).toBe(
      'Suggestion: Opus 5.5 kept more builds (4 of 4, against 1 of 4). The app still uses Sonnet 5.5, because the model for each job is your choice. Change it only if you agree.',
    );
    // Close results: the simplest way that works stays, with no suggestion.
    expect(workflowAdvice('a', [stats('a', 5, 1), stats('b', 4, 0)], nameOf, 0.79)).toHaveLength(1);
    // Too few builds for the other way.
    expect(workflowAdvice('a', [stats('a', 1, 3), stats('b', 2, 0)], nameOf, 0.79)).toHaveLength(1);
    // A safety failure is never outweighed by a better score.
    expect(workflowAdvice('a', [stats('a', 1, 3), stats('b', 4, 0, { safetyFailures: 1 })], nameOf, 0.79)).toHaveLength(1);
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
      expect(advice[0]).toMatch(/^Evidence: Sonnet 5\.5: 1 of 1 builds kept, .*£0\.16 \(\$0\.20\) per kept build, about 2 min each\. A first look, not proof\.$/);
      const out = JSON.parse((await handleLine(JSON.stringify({ id: 1, method: 'workflow_compare', params: { settings: {}, dbPath } })))!);
      expect(out.result).toMatchObject([{ model: 'claude-sonnet-5-5', name: 'Sonnet 5.5', kept: 1, finished: 1 }]);
      expect(out.result[0].text).toMatch(/^Sonnet 5\.5: 1 of 1 builds kept/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

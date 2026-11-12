import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { RunLog, workflowStats, type NewRun } from '../src/index.ts';

const build = (model: string, extra: Partial<NewRun> = {}): NewRun => ({
  at: new Date('2026-11-12T10:00:00Z'),
  slug: 'club-hr',
  feature: 'F-01',
  path: '/runs/x',
  branch: 'aip/x',
  base: 'abc',
  model,
  costUsd: 0.1,
  testsPassed: true,
  fixAttempts: 0,
  summary: '',
  ...extra,
});

describe('whole-workflow results from real builds (CI-4)', () => {
  it('measures each build model end to end, keeping missing numbers missing', () => {
    const log = RunLog.open(':memory:');
    const a = log.add(build('claude-sonnet-5-5', { ms: 120_000 }));
    const b = log.add(build('claude-sonnet-5-5', { costUsd: 0.3, fixAttempts: 2, checks: [{ name: 'checklist', passed: false }, { name: 'axe', passed: false, advisory: true }], ms: 240_000 }));
    log.add(build('claude-sonnet-5-5', { testsPassed: false, checks: [{ name: 'secrets', passed: false, detail: 'Found a key' }] }));
    const c = log.add(build('claude-sonnet-5', { costUsd: null, checks: [{ name: 'secrets', passed: false, detail: 'Not run: no tool' }] }));
    log.decide(a, 'kept', new Date());
    log.decide(b, 'undone', new Date());
    log.decide(c, 'kept', new Date());
    log.rate(a, 4);
    const [s5, s50] = workflowStats(log.list());
    expect(s5).toMatchObject({
      model: 'claude-sonnet-5-5',
      finished: 2,
      kept: 1,
      undone: 1,
      waiting: 1,
      testsFirstTime: 1,
      defects: 3, // a failed checklist, a failed secret scan, and failing tests; advice doesn't count
      safetyFailures: 1,
      avgMs: 180_000,
      rating: 4,
      rated: 1,
    });
    expect(s5!.costUsd).toBeCloseTo(0.5);
    expect(s5!.costPerKeptUsd).toBeCloseTo(0.5);
    // No cost or time recorded: missing, not 0. A scan that didn't run isn't a safety failure.
    expect(s50).toMatchObject({ model: 'claude-sonnet-5', kept: 1, costUsd: null, costPerKeptUsd: null, avgMs: null, rating: null, safetyFailures: 0, defects: 0 });
    log.close();
  });

  it('adds the build time to history files made before CI-4', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aip-wf-'));
    try {
      const path = join(dir, 'history.sqlite');
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY, at TEXT NOT NULL, slug TEXT NOT NULL, feature TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL,
        base TEXT NOT NULL, model TEXT NOT NULL, cost_usd REAL, tests_passed INTEGER NOT NULL, fix_attempts INTEGER NOT NULL, summary TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'built', rating INTEGER, decided_at TEXT, merge_commit TEXT NOT NULL DEFAULT '', kept_into TEXT NOT NULL DEFAULT '',
        checks TEXT NOT NULL DEFAULT '[]', pictures TEXT NOT NULL DEFAULT '[]')`);
      old.exec(`INSERT INTO runs (at, slug, feature, path, branch, base, model, cost_usd, tests_passed, fix_attempts, summary) VALUES ('2026-11-01T00:00:00Z', 's', 'F-01', 'p', 'b', 'c', 'm', 0.1, 1, 0, '')`);
      old.close();
      const log = RunLog.open(path);
      expect(log.list()[0]!.ms).toBeNull();
      log.add(build('m', { ms: 5000 }));
      expect(log.list()[0]!.ms).toBe(5000);
      log.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

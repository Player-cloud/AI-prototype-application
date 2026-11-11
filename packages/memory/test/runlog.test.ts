import { describe, expect, it } from 'vitest';
import { RunLog, type NewRun } from '../src/runlog.ts';

const AT = new Date('2026-11-11T19:30:00Z');
const run = (over: Partial<NewRun> = {}): NewRun => ({
  at: AT,
  slug: 'club-hr',
  feature: 'F-01',
  path: '/code/club-hr-runs/F-01-x',
  branch: 'aip/f-01-x',
  base: 'abc',
  model: 'claude-sonnet-5-5',
  costUsd: 0.42,
  testsPassed: true,
  fixAttempts: 0,
  summary: 'Added the login page.',
  ...over,
});

describe('build runs', () => {
  it('saves each build waiting for Keep or Undo, newest first, per project', () => {
    const log = RunLog.open(':memory:');
    const a = log.add(run());
    const b = log.add(run({ feature: 'F-02', testsPassed: false, fixAttempts: 2, costUsd: null }));
    log.add(run({ slug: 'school' }));
    expect(log.list('club-hr').map((r) => r.id)).toEqual([b, a]);
    expect(log.get(b)).toMatchObject({ feature: 'F-02', testsPassed: false, fixAttempts: 2, costUsd: null, status: 'built', rating: null });
    expect(log.list()).toHaveLength(3);
  });

  it('records Keep or Undo once, and a 1–5 rating that can change', () => {
    const log = RunLog.open(':memory:');
    const id = log.add(run());
    log.decide(id, 'kept', AT, { mergeCommit: 'def', keptInto: 'main' });
    expect(log.get(id)).toMatchObject({ status: 'kept', decidedAt: AT.toISOString(), mergeCommit: 'def', keptInto: 'main' });
    expect(() => log.decide(id, 'undone', AT)).toThrow('That build was already kept or undone.');
    log.rate(id, 4);
    log.rate(id, 5);
    expect(log.get(id)?.rating).toBe(5);
    expect(() => log.rate(id, 6)).toThrow('Rating must be a whole number from 1 to 5');
    expect(() => log.rate(999, 3)).toThrow('There’s no such build.');
  });

  it('finds the last build’s pictures to compare screens with', () => {
    const log = RunLog.open(':memory:');
    expect(log.lastPictures('club-hr')).toEqual([]);
    log.add(run({ pictures: [{ name: 'desktop', path: '/p/1.png', hash: 'a' }] }));
    log.add(run({ feature: 'F-02' })); // no pictures this time
    log.add(run({ slug: 'school', pictures: [{ name: 'desktop', path: '/s.png', hash: 's' }] }));
    expect(log.lastPictures('club-hr')).toEqual([{ name: 'desktop', path: '/p/1.png', hash: 'a' }]);
  });

  it('opens a history file made before free checks and pictures', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'aip-runlog-'));
    const path = join(dir, 'history.sqlite');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY, at TEXT NOT NULL, slug TEXT NOT NULL, feature TEXT NOT NULL, path TEXT NOT NULL,
      branch TEXT NOT NULL, base TEXT NOT NULL, model TEXT NOT NULL, cost_usd REAL, tests_passed INTEGER NOT NULL, fix_attempts INTEGER NOT NULL,
      summary TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'built', rating INTEGER, decided_at TEXT, merge_commit TEXT NOT NULL DEFAULT '', kept_into TEXT NOT NULL DEFAULT '')`);
    old.exec(`INSERT INTO runs (at, slug, feature, path, branch, base, model, tests_passed, fix_attempts, summary) VALUES ('2026-11-11', 'club-hr', 'F-01', '/p', 'b', 'c', 'm', 1, 0, 's')`);
    old.close();
    const log = RunLog.open(path);
    expect(log.get(1)).toMatchObject({ feature: 'F-01', checks: [], pictures: [] });
    log.close();
    await rm(dir, { recursive: true, force: true });
  });
});

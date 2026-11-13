import { describe, expect, it } from 'vitest';
import { RunLog, findingsFromStored, type NewRun } from '../src/runlog.ts';

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
    expect(log.get(1)).toMatchObject({ feature: 'F-01', findings: [], pictures: [] });
    log.close();
    await rm(dir, { recursive: true, force: true });
  });
  it('adds a build’s row at the start and fills in the same row when it finishes', () => {
    const log = RunLog.open(':memory:');
    const id = log.start({ at: AT, slug: 'club-hr', feature: 'F-01', path: '/p', branch: 'b', base: 'c', model: 'm' });
    expect(log.get(id)).toMatchObject({ status: 'running', cause: null, error: '', endedAt: null, costUsd: null, summary: '' });
    // Nothing can be kept, undone or rated while it is running.
    expect(() => log.decide(id, 'kept', AT)).toThrow();
    expect(() => log.rate(id, 3)).toThrow('There’s no such build.');
    log.finish(id, { costUsd: 0.3, testsPassed: true, fixAttempts: 1, summary: 'Done.', checks: [{ name: 'secrets', passed: true }], pictures: [], ms: 5000 });
    expect(log.get(id)).toMatchObject({ id, status: 'built', costUsd: 0.3, fixAttempts: 1, summary: 'Done.', ms: 5000, cause: null });
    expect(log.list()).toHaveLength(1);
    log.decide(id, 'kept', AT);
    log.close();
  });

  it('a failed or stopped build keeps its cause, message and cost, and can’t be kept or rated', () => {
    const log = RunLog.open(':memory:');
    const start = () => log.start({ at: AT, slug: 'club-hr', feature: 'F-01', path: '/p', branch: 'b', base: 'c', model: 'm' });
    const a = start();
    log.fail(a, { status: 'failed', cause: 'budget', error: 'Stopped: cost limit.', costUsd: 0.1, ms: 900, at: AT });
    expect(log.get(a)).toMatchObject({ status: 'failed', cause: 'budget', error: 'Stopped: cost limit.', costUsd: 0.1, ms: 900, endedAt: AT.toISOString() });
    const b = start();
    log.fail(b, { status: 'stopped', cause: 'stopped', error: 'Stopped.', costUsd: 0, ms: 10, at: AT });
    expect(log.get(b)).toMatchObject({ status: 'stopped', cause: null });
    for (const id of [a, b]) {
      expect(() => log.decide(id, 'kept', AT)).toThrow('That build was already kept or undone.');
      expect(() => log.decide(id, 'undone', AT)).toThrow();
      expect(() => log.setChecks(id, [])).toThrow();
      expect(() => log.rate(id, 5)).toThrow('There’s no such build.');
    }
    // A run already failed can't be finished afterwards.
    expect(() => log.finish(a, { costUsd: 1, testsPassed: true, fixAttempts: 0, summary: 'x' })).toThrow('That build isn’t running.');
    log.close();
  });

  it('a row still running from an earlier start becomes interrupted when the file is opened', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'aip-runlog-'));
    try {
      const path = join(dir, 'history.sqlite');
      const first = RunLog.open(path);
      const mine = first.start({ at: AT, slug: 'club-hr', feature: 'F-01', path: '/p', branch: 'b', base: 'c', model: 'm' });
      // This program started it, so another opening (the build's own, or a list) leaves it running.
      const second = RunLog.open(path);
      expect(second.get(mine)?.status).toBe('running');
      second.close();
      first.close();
      // A row made by an earlier program: nothing here started it.
      const old = new DatabaseSync(path);
      old.exec("INSERT INTO runs (at, slug, feature, path, branch, base, model, tests_passed, fix_attempts, summary, status) VALUES ('2026-11-10', 'club-hr', 'F-00', '/q', 'b0', 'c', 'm', 0, 0, '', 'running')");
      old.close();
      const log = RunLog.open(path);
      const left = log.list().find((r) => r.feature === 'F-00')!;
      expect(left).toMatchObject({ status: 'interrupted', cause: null });
      expect(left.error).toContain('closed while this build was running');
      expect(left.endedAt).not.toBeNull();
      expect(log.get(mine)?.status).toBe('running');
      expect(() => log.decide(left.id, 'kept', AT)).toThrow();
      log.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('adds the cause, error and end time to a history file made before run records, keeping its rows', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'aip-runlog-'));
    try {
      const path = join(dir, 'history.sqlite');
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY, at TEXT NOT NULL, slug TEXT NOT NULL, feature TEXT NOT NULL, path TEXT NOT NULL,
        branch TEXT NOT NULL, base TEXT NOT NULL, model TEXT NOT NULL, cost_usd REAL, tests_passed INTEGER NOT NULL, fix_attempts INTEGER NOT NULL,
        summary TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'built', rating INTEGER, decided_at TEXT, merge_commit TEXT NOT NULL DEFAULT '', kept_into TEXT NOT NULL DEFAULT '',
        checks TEXT NOT NULL DEFAULT '[]', pictures TEXT NOT NULL DEFAULT '[]', ms INTEGER)`);
      old.exec(`INSERT INTO runs (at, slug, feature, path, branch, base, model, tests_passed, fix_attempts, summary, status) VALUES ('2026-11-11', 'club-hr', 'F-01', '/p', 'b', 'c', 'm', 1, 0, 's', 'kept')`);
      old.close();
      const log = RunLog.open(path);
      expect(log.get(1)).toMatchObject({ status: 'kept', cause: null, error: '', endedAt: null, mapHit: null, mapChanged: null });
      log.setMapHit(1, 0.8, 5);
      expect(log.get(1)).toMatchObject({ mapHit: 0.8, mapChanged: 5 });
      const id = log.start({ at: AT, slug: 'club-hr', feature: 'F-02', path: '/p', branch: 'b2', base: 'c', model: 'm' });
      log.fail(id, { status: 'failed', cause: 'model', error: 'x', costUsd: null, ms: 1, at: AT });
      expect(log.get(id)).toMatchObject({ status: 'failed', cause: 'model' });
      log.close();
      RunLog.open(path).close(); // opening again is fine
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('findings in run rows', () => {
  const SOURCES_OK = ['tool', 'model', 'rule'];

  it('saves findings and reads them back in the same shape', () => {
    const log = RunLog.open(':memory:');
    const id = log.start({ at: AT, slug: 'club-hr', feature: 'F-01', path: '/p', branch: 'b', base: 'c', model: 'm' });
    const findings = [
      { check: 'secrets', level: 'pass' as const, title: 'Secret scan: passed', source: 'tool' as const },
      { check: 'checklist', level: 'warn' as const, title: 'Checklist rules: advice (doesn’t stop Keep)', detail: 'a.tsx:1 (Security): Use https:// links.', file: 'a.tsx', line: 1, source: 'rule' as const },
    ];
    log.finish(id, { costUsd: 0.3, testsPassed: true, fixAttempts: 0, summary: 's', findings, pictures: [], ms: 1 });
    expect(log.get(id)!.findings).toEqual(findings);
    log.close();
  });

  it('reads a row saved with the OLD checks shape through the converter', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'aip-runlog-'));
    const path = join(dir, 'history.sqlite');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY, at TEXT NOT NULL, slug TEXT NOT NULL, feature TEXT NOT NULL, path TEXT NOT NULL,
      branch TEXT NOT NULL, base TEXT NOT NULL, model TEXT NOT NULL, cost_usd REAL, tests_passed INTEGER NOT NULL, fix_attempts INTEGER NOT NULL,
      summary TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'built', rating INTEGER, decided_at TEXT, merge_commit TEXT NOT NULL DEFAULT '', kept_into TEXT NOT NULL DEFAULT '',
      checks TEXT NOT NULL DEFAULT '[]', pictures TEXT NOT NULL DEFAULT '[]', ms INTEGER)`);
    const oldChecks = [
      { name: 'secrets', passed: true, advisory: false, detail: 'No keys found in 1 changed file.' },
      { name: 'audit', passed: false, advisory: true, detail: 'Not run: no internet.' },
      { name: 'checklist', passed: false, advisory: true, detail: 'a.tsx:1 (Security): Use https:// links.' },
      { name: 'dependencies', passed: false, advisory: false, detail: 'New: left-pad ^1.3.0 (dependencies in package.json)' },
    ];
    old.prepare("INSERT INTO runs (at, slug, feature, path, branch, base, model, tests_passed, fix_attempts, summary, checks) VALUES ('2026-11-11', 'club-hr', 'F-01', '/p', 'b', 'c', 'm', 1, 0, 's', ?)").run(JSON.stringify(oldChecks));
    old.close();

    const log = RunLog.open(path);
    const got = log.get(1)!.findings;
    expect(got.map((f) => [f.check, f.level])).toEqual([['secrets', 'pass'], ['audit', 'info'], ['checklist', 'warn'], ['dependencies', 'block']]);
    expect(got[3]).toEqual({ check: 'dependencies', level: 'block', title: 'New packages: need your OK before Keep', detail: 'New: left-pad ^1.3.0 (dependencies in package.json)', source: 'rule' });
    expect(got.every((f) => SOURCES_OK.includes(f.source) && typeof f.title === 'string')).toBe(true);
    // An old waiting build that was blocked is still blocked after conversion.
    expect(got.some((f) => f.level === 'block')).toBe(true);
    // Saving findings back over an old row works (joshua's OK for new packages), and then reads as findings.
    log.setFindings(1, got.map((f) => (f.check === 'dependencies' ? { ...f, level: 'pass' as const } : f)));
    expect(log.get(1)!.findings.some((f) => f.level === 'block')).toBe(false);
    log.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('old-shape checks given when saving are stored as findings, and a mix reads fine', () => {
    const log = RunLog.open(':memory:');
    const id = log.add(run({ checks: [{ name: 'secrets', passed: false }] }));
    expect(log.get(id)!.findings).toEqual([{ check: 'secrets', level: 'block', title: 'Secret scan: failed', source: 'tool' }]);
    expect(findingsFromStored([{ name: 'axe', passed: true }, { check: 'x', level: 'warn', title: 'T', source: 'rule' }, { check: 'bad', level: 'nonsense' }, 'junk', null])).toEqual([
      { check: 'axe', level: 'pass', title: 'Accessibility: passed', source: 'tool' },
      { check: 'x', level: 'warn', title: 'T', source: 'rule' },
    ]);
    expect(findingsFromStored('not a list')).toEqual([]);
    log.close();
  });
});

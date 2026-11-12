import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunLog } from '@aip/memory';
import { handleLine } from '../src/protocol.ts';

const NOW = new Date('2026-11-11T19:30:00Z');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
const exists = (p: string) => access(p).then(() => true, () => false);

describe('Keep or Undo a build', () => {
  let root = '';
  let code = '';
  let db = '';
  let settings: Record<string, unknown> = {};
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'aip-keep-')));
    code = join(root, 'club-hr');
    db = join(root, 'history.sqlite');
    settings = { codeFolders: { 'club-hr': code } };
    execFileSync('git', ['init', '-q', '-b', 'main', code]);
    // Repo-local settings, shared by the build copies (worktrees).
    git(code, 'config', 'user.name', 'Test');
    git(code, 'config', 'user.email', 'test@example.invalid');
    git(code, 'config', 'commit.gpgsign', 'false');
    git(code, 'config', 'core.autocrlf', 'false');
    await writeFile(join(code, 'README.md'), '# Club HR\n');
    git(code, 'add', '.');
    git(code, 'commit', '-q', '-m', 'first');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A finished build: its own copy with the model's (uncommitted) work, saved in the history file. */
  async function built(feature = 'F-01', testsPassed = true, checks: { name: string; passed: boolean; advisory?: boolean; detail?: string }[] = []) {
    const branch = `aip/${feature.toLowerCase()}-20261111-193000`;
    const path = join(root, 'club-hr-runs', `${feature}-20261111-193000`);
    git(code, 'worktree', 'add', '-q', '-b', branch, path, 'HEAD');
    await writeFile(join(path, `${feature}.md`), `${feature} page\n`);
    const log = RunLog.open(db);
    const id = log.add({ at: NOW, slug: 'club-hr', feature, path, branch, base: git(code, 'rev-parse', 'HEAD').trim(), model: 'claude-sonnet-5-5', costUsd: 0.42, testsPassed, fixAttempts: 0, summary: 'Added it.', checks });
    log.close();
    return { id, path, branch };
  }

  const call = async (method: string, params: Record<string, unknown>) =>
    JSON.parse(await handleLine(JSON.stringify({ id: 1, method, params }), { now: () => NOW } as never));

  it('keeps a build: merges it into joshua’s copy (no push) and removes the build’s copy', async () => {
    const b = await built();
    const r = await call('run_keep', { settings, dbPath: db, id: b.id });
    expect(r.error).toBeUndefined();
    expect(r.result.note).toBe('Kept F-01 in your copy on main. Nothing was pushed.');
    expect(r.result.run).toMatchObject({ status: 'kept', keptInto: 'main' });
    expect(await readFile(join(code, 'F-01.md'), 'utf8')).toBe('F-01 page\n');
    expect(git(code, 'log', '-1', '--format=%s').trim()).toBe(`Keep F-01 (build ${b.branch})`);
    expect(r.result.run.mergeCommit).toBe(git(code, 'rev-parse', 'HEAD').trim());
    expect(await exists(b.path)).toBe(false);
    expect(git(code, 'branch', '--list', 'aip/*').trim()).toBe('');
    expect(git(code, 'status', '--porcelain').trim()).toBe('');

    // Once decided, it can't be decided again; it can still be rated.
    expect((await call('run_undo', { settings, dbPath: db, id: b.id })).error).toBe('That build was already kept.');
    expect((await call('run_rate', { dbPath: db, id: b.id, rating: 4 })).result.run.rating).toBe(4);
    expect((await call('run_list', { dbPath: db, slug: 'club-hr' })).result.map((x: { status: string }) => x.status)).toEqual(['kept']);
  });

  it('refuses to keep a build whose tests fail', async () => {
    const b = await built('F-01', false);
    const r = await call('run_keep', { settings, dbPath: db, id: b.id });
    expect(r.error).toBe('The tests fail, so this build can’t be kept. Undo it, or build the feature again.');
    expect(await exists(join(code, 'F-01.md'))).toBe(false);
  });

  it('refuses to keep a build whose secret scan or audit failed; advice alone doesn’t block', async () => {
    const b = await built('F-01', true, [
      { name: 'secrets', passed: false },
      { name: 'checklist', passed: false, advisory: true },
    ]);
    expect((await call('run_keep', { settings, dbPath: db, id: b.id })).error).toBe('These checks must pass before it can be kept: secrets. Undo it, or build the feature again.');
    const ok = await built('F-02', true, [{ name: 'checklist', passed: false, advisory: true }]);
    expect((await call('run_keep', { settings, dbPath: db, id: ok.id })).result.run.status).toBe('kept');
  });

  it('refuses to keep new packages until joshua approves them, then keeps', async () => {
    const detail = 'New: left-pad ^1.3.0 (dependencies in package.json)\nNew: zod ~3.0.0 (devDependencies in package.json)\nNew packages need your OK before Keep.';
    const b = await built('F-01', true, [{ name: 'secrets', passed: true }, { name: 'dependencies', passed: false, detail }]);
    const refused = 'This build added new packages, and they need your OK first. Open the app on your PC, press “Approve new packages” on the build, then keep it.';
    expect((await call('run_keep', { settings, dbPath: db, id: b.id })).error).toBe(refused);
    expect(await exists(join(code, 'F-01.md'))).toBe(false);

    const ok = await call('deps_approve', { dbPath: db, id: b.id });
    expect(ok.error).toBeUndefined();
    expect(ok.result.keep).toEqual({ keep: true, blocking: [] });
    expect(ok.result.note).toBe('Approved the new packages for F-01: left-pad ^1.3.0 (dependencies in package.json), zod ~3.0.0 (devDependencies in package.json).');
    const stored = ok.result.run.findings.find((f: { check: string }) => f.check === 'dependencies');
    expect(stored).toEqual({
      check: 'dependencies',
      level: 'pass',
      title: 'New packages: approved by joshua',
      source: 'rule',
      detail: 'Approved by joshua on 2026-11-11: left-pad ^1.3.0 (dependencies in package.json); zod ~3.0.0 (devDependencies in package.json)',
    });
    // It is in the change history, and can't be "undone" there.
    const hist = (await call('history_list', { dbPath: db })).result;
    expect(hist[0]).toMatchObject({ kind: 'approval', label: 'Approved new packages for F-01: left-pad ^1.3.0 (dependencies in package.json), zod ~3.0.0 (devDependencies in package.json)' });
    expect((await call('undo', { dbPath: db, id: hist[0].id, settings })).error).toBe('An approval can’t be undone here. Undo the build instead.');

    expect((await call('run_keep', { settings, dbPath: db, id: b.id })).result.run.status).toBe('kept');
    // Nothing left to approve.
    expect((await call('deps_approve', { dbPath: db, id: b.id })).error).toBe('That build was already kept.');
  });

  it('only approves a build that has new packages waiting, and other failed checks still block', async () => {
    const clean = await built('F-01');
    expect((await call('deps_approve', { dbPath: db, id: clean.id })).error).toBe('This build has no new packages waiting for your OK.');
    const both = await built('F-02', true, [{ name: 'secrets', passed: false }, { name: 'dependencies', passed: false, detail: 'New: a 1.0.0 (dependencies in package.json)' }]);
    expect((await call('run_keep', { settings, dbPath: db, id: both.id })).error).toBe('These checks must pass before it can be kept: secrets. Undo it, or build the feature again.');
    const r = await call('deps_approve', { dbPath: db, id: both.id });
    expect(r.result.keep).toEqual({ keep: false, blocking: ['secrets'] });
  });

  it('refuses while joshua’s copy has uncommitted changes', async () => {
    const b = await built();
    await writeFile(join(code, 'notes.txt'), 'mine\n');
    const r = await call('run_keep', { settings, dbPath: db, id: b.id });
    expect(r.error).toBe(`Your copy (${code}) has changes not committed yet. Commit them or put them aside, then press Keep again.`);
    expect((await call('run_list', { dbPath: db })).result[0].status).toBe('built');
  });

  it('changes nothing when the build clashes with joshua’s newer work', async () => {
    const b = await built();
    await writeFile(join(b.path, 'README.md'), '# Club HR (build)\n');
    await writeFile(join(code, 'README.md'), '# Club HR (mine)\n');
    git(code, 'commit', '-q', '-am', 'my change');
    const before = git(code, 'rev-parse', 'HEAD').trim();
    const r = await call('run_keep', { settings, dbPath: db, id: b.id });
    expect(r.error).toMatch(/^Couldn’t keep F-01: it clashes with changes in your copy, so nothing was changed\./);
    expect(git(code, 'rev-parse', 'HEAD').trim()).toBe(before);
    expect(git(code, 'status', '--porcelain').trim()).toBe('');
    expect(await readFile(join(code, 'README.md'), 'utf8')).toBe('# Club HR (mine)\n');
  });

  it('undoes a build: removes its copy and branch, leaving joshua’s copy alone', async () => {
    const b = await built();
    const r = await call('run_undo', { settings, dbPath: db, id: b.id });
    expect(r.result.note).toBe('Undone: F-01’s build was removed. Your copy wasn’t touched.');
    expect(await exists(b.path)).toBe(false);
    expect(git(code, 'branch', '--list', 'aip/*').trim()).toBe('');
    expect(await exists(join(code, 'F-01.md'))).toBe(false);
    expect((await call('run_rate', { dbPath: db, id: b.id, rating: 9 })).error).toBe('Rating must be a whole number from 1 to 5');
  });

  it('undoes a build whose copy was already deleted by hand', async () => {
    const b = await built();
    await rm(b.path, { recursive: true, force: true });
    const r = await call('run_undo', { settings, dbPath: db, id: b.id });
    expect(r.result.run.status).toBe('undone');
    expect(git(code, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });
  it('refuses to keep a failed, stopped or interrupted build; Undo only removes its copy and keeps the record', async () => {
    const mk = async (feature: string, end: (log: RunLog, id: number) => void) => {
      const b = await built(feature);
      const raw = RunLog.open(db);
      const id = raw.start({ at: NOW, slug: 'club-hr', feature, path: b.path, branch: b.branch, base: 'x', model: 'claude-sonnet-5-5' });
      end(raw, id);
      raw.close();
      return { ...b, id };
    };
    const failed = await mk('F-02', (l, id) => l.fail(id, { status: 'failed', cause: 'model', error: 'The model ended without an answer.', costUsd: 0.2, ms: 5, at: NOW }));
    const stopped = await mk('F-03', (l, id) => l.fail(id, { status: 'stopped', error: 'Stopped.', costUsd: 0, ms: 5, at: NOW }));
    for (const [b, word] of [[failed, 'failed'], [stopped, 'was stopped']] as const) {
      const r = await call('run_keep', { settings, dbPath: db, id: b.id });
      expect(r.error).toBe(`That build ${word}, so it can’t be kept.`);
      expect(await exists(join(code, `${b.id}.md`))).toBe(false);
      expect((await call('run_rate', { dbPath: db, id: b.id, rating: 4 })).error).toBeDefined();
    }
    // Both are listed with their cause.
    const list = (await call('run_list', { dbPath: db, slug: 'club-hr' })).result.filter((r: { status: string }) => r.status !== 'built');
    expect(list).toMatchObject([{ status: 'stopped', cause: null }, { status: 'failed', cause: 'model', error: 'The model ended without an answer.' }]);
    // Undo removes the unfinished copy and its branch, but the record stays 'failed'.
    expect(await exists(failed.path)).toBe(true);
    const u = await call('run_undo', { settings, dbPath: db, id: failed.id });
    expect(u.error).toBeUndefined();
    expect(u.result.run).toMatchObject({ status: 'failed', cause: 'model' });
    expect(u.result.run.decidedAt).not.toBeNull();
    expect(await exists(failed.path)).toBe(false);
    expect(git(code, 'branch', '--list', failed.branch).trim()).toBe('');
    // A build that is still running can't be kept or undone.
    const running = RunLog.open(db);
    const rid = running.start({ at: NOW, slug: 'club-hr', feature: 'F-04', path: '/nowhere', branch: 'aip/none', base: 'x', model: 'm' });
    running.close();
    expect((await call('run_keep', { settings, dbPath: db, id: rid })).error).toBe('That build is still running.');
    expect((await call('run_undo', { settings, dbPath: db, id: rid })).error).toBe('That build is still running.');
  });
});

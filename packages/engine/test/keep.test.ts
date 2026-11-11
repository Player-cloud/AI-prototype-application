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
  async function built(feature = 'F-01', testsPassed = true, checks: { name: string; passed: boolean; advisory?: boolean }[] = []) {
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
});

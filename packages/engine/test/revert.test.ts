import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChangeLog, RunLog } from '@aip/memory';
import { handleLine } from '../src/protocol.ts';

const NOW = new Date('2026-11-11T19:30:00Z');
const LATER = new Date('2026-11-12T09:00:00Z');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
const exists = (p: string) => access(p).then(() => true, () => false);

describe('Undo a kept build', () => {
  let root = '';
  let code = '';
  let data = '';
  let db = '';
  let settings: Record<string, unknown> = {};
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'aip-revert-')));
    code = join(root, 'club-hr');
    data = join(root, 'data');
    db = join(root, 'history.sqlite');
    settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    execFileSync('git', ['init', '-q', '-b', 'main', code]);
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

  async function built(feature = 'F-01', edit?: (path: string) => Promise<void>) {
    const branch = `aip/${feature.toLowerCase()}-20261111-193000`;
    const path = join(root, 'club-hr-runs', `${feature}-20261111-193000`);
    git(code, 'worktree', 'add', '-q', '-b', branch, path, 'HEAD');
    await writeFile(join(path, `${feature}.md`), `${feature} page\n`);
    await edit?.(path);
    const log = RunLog.open(db);
    const id = log.add({ at: NOW, slug: 'club-hr', feature, path, branch, base: git(code, 'rev-parse', 'HEAD').trim(), model: 'claude-sonnet-5-5', costUsd: 0.42, testsPassed: true, fixAttempts: 0, summary: 'Added it.', checks: [] });
    log.close();
    return { id };
  }
  const call = async (method: string, params: Record<string, unknown>) =>
    JSON.parse(await handleLine(JSON.stringify({ id: 1, method, params }), { now: () => LATER, modelName: (id: string) => id } as never));
  const keep = async (feature = 'F-01', edit?: (path: string) => Promise<void>) => {
    const b = await built(feature, edit);
    const r = await call('run_keep', { settings, dbPath: db, id: b.id });
    expect(r.error).toBeUndefined();
    return b;
  };
  const revert = (id: number) => call('run_revert', { settings, dbPath: db, id });
  const status = (id: number) => RunLog.open(db).get(id)!.status;
  const commits = () => git(code, 'rev-list', 'HEAD').trim().split('\n');

  it('adds one revert commit, restores the files and keeps every earlier commit as it was', async () => {
    const b = await keep('F-01', (p) => writeFile(join(p, 'README.md'), '# Club HR\nwith F-01\n'));
    const before = commits();
    const r = await revert(b.id);
    expect(r.error).toBeUndefined();
    expect(r.result.note).toBe('Undid F-01: a new commit on main reverses it. Nothing was pushed and no history was rewritten.');
    expect(r.result.run.status).toBe('reverted');
    expect(await exists(join(code, 'F-01.md'))).toBe(false);
    expect(await readFile(join(code, 'README.md'), 'utf8')).toBe('# Club HR\n');
    const after = commits();
    expect(after).toHaveLength(before.length + 1);
    expect(after.slice(1)).toEqual(before);
    expect(git(code, 'log', '-1', '--format=%s').trim()).toMatch(/^Revert "Keep F-01 /);
    expect(git(code, 'status', '--porcelain').trim()).toBe('');
  });

  it('records the change in History and takes the kept build out of the project map', async () => {
    const b = await keep();
    const mapFile = join(data, 'projects', 'club-hr', 'map.json');
    expect(JSON.parse(await readFile(mapFile, 'utf8')).features['F-01'].files).toEqual(['F-01.md']);
    await revert(b.id);
    const h = ChangeLog.open(db);
    const entry = h.list().find((c) => c.kind === 'revert')!;
    h.close();
    expect(entry.label).toBe('Undid kept build: F-01');
    expect(entry.after).toBe(git(code, 'rev-parse', 'HEAD').trim());
    expect(JSON.parse(await readFile(mapFile, 'utf8')).features).toEqual({});
    // A reversed build is rated and counted like an undone one, and can't be reversed twice.
    expect((await call('run_rate', { dbPath: db, id: b.id, rating: 2 })).result.run.rating).toBe(2);
    expect((await revert(b.id)).error).toBe('That kept build was already undone.');
    // The History screen can't "undo" it a second way.
    expect((await call('undo', { dbPath: db, id: entry.id, settings: {} })).error).toBe('A reversed build can’t be undone here. Build the feature again if you want it back.');
  });

  it('only touches the reversed feature in the map', async () => {
    const a = await keep('F-01');
    await keep('F-02');
    await revert(a.id);
    const map = JSON.parse(await readFile(join(data, 'projects', 'club-hr', 'map.json'), 'utf8'));
    expect(Object.keys(map.features)).toEqual(['F-02']);
    expect(map.features['F-02'].files).toEqual(['F-02.md']);
  });

  it('refuses while the copy has uncommitted changes, and changes nothing', async () => {
    const b = await keep();
    await writeFile(join(code, 'notes.txt'), 'mine\n');
    const head = git(code, 'rev-parse', 'HEAD').trim();
    const r = await revert(b.id);
    expect(r.error).toBe(`Your copy (${code}) has changes not committed yet. Commit them or put them aside, then press Undo this kept build again. Nothing was changed.`);
    expect(git(code, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(await exists(join(code, 'F-01.md'))).toBe(true);
    expect(status(b.id)).toBe('kept');
  });

  it('aborts cleanly and names the files when the reversal clashes with later work', async () => {
    const b = await keep('F-01', (p) => writeFile(join(p, 'README.md'), '# Club HR\nfrom the build\n'));
    await writeFile(join(code, 'README.md'), '# Club HR\nmy later edit\n');
    git(code, 'commit', '-q', '-am', 'later work');
    const head = git(code, 'rev-parse', 'HEAD').trim();
    const r = await revert(b.id);
    expect(r.error).toBe('Couldn’t undo F-01: these files clash with later changes: README.md. Nothing was changed.');
    expect(git(code, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(git(code, 'status', '--porcelain').trim()).toBe('');
    expect(await exists(join(code, '.git', 'REVERT_HEAD'))).toBe(false);
    expect(await readFile(join(code, 'README.md'), 'utf8')).toBe('# Club HR\nmy later edit\n');
    expect(await exists(join(code, 'F-01.md'))).toBe(true);
    expect(status(b.id)).toBe('kept');
    const h = ChangeLog.open(db);
    expect(h.list().some((c) => c.kind === 'revert')).toBe(false);
    h.close();
  });

  it('refuses when the kept commit isn’t in the checked-out branch, or isn’t known', async () => {
    const b = await keep();
    git(code, 'checkout', '-q', '-b', 'other', 'HEAD~1');
    const head = git(code, 'rev-parse', 'HEAD').trim();
    const r = await revert(b.id);
    expect(r.error).toBe('The commit that kept F-01 isn’t in the history of other, so it can’t be reversed here. Check out the branch it was kept into (main). Nothing was changed.');
    expect(git(code, 'rev-parse', 'HEAD').trim()).toBe(head);
    git(code, 'checkout', '-q', 'main');
    // A commit the repo has never seen.
    const log = RunLog.open(db);
    const other = await built('F-03');
    log.decide(other.id, 'kept', NOW, { mergeCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', keptInto: 'main' });
    log.close();
    expect((await revert(other.id)).error).toMatch(/^The commit that kept F-03 isn’t in the history of main/);
    // A real commit that wasn't the Keep merge is never reversed.
    const log2 = RunLog.open(db);
    const third = await built('F-04');
    log2.decide(third.id, 'kept', NOW, { mergeCommit: git(code, 'rev-parse', 'HEAD~1').trim(), keptInto: 'main' });
    log2.close();
    expect((await revert(third.id)).error).toMatch(/^The commit that kept F-04 isn’t in the history of main/);
    expect(await exists(join(code, 'F-01.md'))).toBe(true);
  });

  it('refuses a run that isn’t kept, or has no saved commit', async () => {
    const waiting = await built('F-01');
    expect((await revert(waiting.id)).error).toBe('Only a kept build can be undone this way.');
    expect(status(waiting.id)).toBe('built');
    expect((await call('run_undo', { settings, dbPath: db, id: waiting.id })).error).toBeUndefined();
    expect((await revert(waiting.id)).error).toBe('Only a kept build can be undone this way.');
    expect((await revert(999)).error).toBe('There’s no such build.');
    const old = await built('F-02');
    const log = RunLog.open(db);
    log.decide(old.id, 'kept', NOW); // an older record with no saved commit
    log.close();
    expect((await revert(old.id)).error).toMatch(/no record of which commit kept this build/);
    expect(status(old.id)).toBe('kept');
  });
});

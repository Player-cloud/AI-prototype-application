import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckResult, Exec, UpdateFound } from '@aip/checks';
import { INSTALL_ARGS } from '@aip/checks';
import { MAINTENANCE_MODEL, RunLog, learnHabits, workflowStats } from '@aip/memory';
import { GITHUB_UNAVAILABLE, MAX_PER_RUN, OFF_TEXT, classifyPatch, editSpec, runMaintenance, sectionsOf, type MaintenanceOptions } from '../src/maintenance.ts';
import { keepRun, revertKept } from '../src/keep.ts';
import { handleLine } from '../src/protocol.ts';
import { DEFAULT_SETTINGS, checkSettings } from '../src/settings.ts';
import { describeSettingsChange } from '../src/history.ts';

const NOW = new Date('2026-11-12T10:00:00Z');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
const exists = (p: string) => access(p).then(() => true, () => false);

const found = (name: string, from: string, to: string): UpdateFound => ({ package: name, current: from, latest: to, level: 'patch', deprecated: false, usedBy: [], capability: '' });

describe('classifyPatch: only dev-tool patch updates', () => {
  const ok = (spec: string, from = '1.2.3', to = '1.2.7', sections: ('dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies')[] = ['devDependencies']) =>
    classifyPatch({ name: 'tool', sections, spec, from, to });

  it('accepts a higher patch in the same major and minor, keeping the range style', () => {
    expect(ok('^1.2.3')).toEqual({ ok: true, newSpec: '^1.2.7' });
    expect(ok('~1.2.3')).toEqual({ ok: true, newSpec: '~1.2.7' });
    expect(ok('1.2.3')).toEqual({ ok: true, newSpec: '1.2.7' });
    expect(ok('^1.2.0')).toEqual({ ok: true, newSpec: '^1.2.7' });
  });

  it('refuses a minor or a major update', () => {
    expect(ok('^1.2.3', '1.2.3', '1.3.0')).toMatchObject({ ok: false, why: expect.stringContaining('minor') });
    expect(ok('^1.2.3', '1.2.3', '2.0.0')).toMatchObject({ ok: false, why: expect.stringContaining('major') });
    expect(ok('^1.2.3', '1.2.3', '1.3.9')).toMatchObject({ ok: false });
  });

  it('refuses anything that is not a dev dependency', () => {
    for (const s of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      expect(ok('^1.2.3', '1.2.3', '1.2.7', [s])).toMatchObject({ ok: false, why: expect.stringContaining('isn’t a dev tool') });
    }
    expect(ok('^1.2.3', '1.2.3', '1.2.7', ['devDependencies', 'dependencies'])).toMatchObject({ ok: false, why: expect.stringContaining('more than one place') });
    expect(ok('^1.2.3', '1.2.3', '1.2.7', [])).toMatchObject({ ok: false });
  });

  it('refuses pre-releases, an older or equal patch, and odd version numbers', () => {
    expect(ok('^1.2.3', '1.2.3', '1.2.7-beta.1')).toMatchObject({ ok: false, why: expect.stringContaining('pre-release') });
    expect(ok('^1.2.3', '1.2.3-rc.1', '1.2.7')).toMatchObject({ ok: false });
    expect(ok('^1.2.3', '1.2.3', '1.2.3')).toMatchObject({ ok: false });
    expect(ok('^1.2.3', '1.2.7', '1.2.3')).toMatchObject({ ok: false });
    expect(ok('^1.2.3', '1.2', '1.2.7')).toMatchObject({ ok: false });
    expect(ok('^1.2.3', '1.2.3+build', '1.2.7')).toMatchObject({ ok: false });
    expect(ok('^1.2.3', '1.2.3', 'latest')).toMatchObject({ ok: false });
  });

  it('refuses ranges and specs it cannot parse, and git, url, file, workspace and alias specs', () => {
    for (const spec of ['>=1.2.3', '^1.2.3 || ^2.0.0', '1.x', '*', 'latest', '^1.2', '1.2.3 - 1.2.9', '^1.2.3-beta.1', 'git+https://github.com/a/b.git', 'github:a/b', 'https://x.invalid/a.tgz', 'file:../tool', 'link:../tool', 'workspace:*', 'npm:other@1.2.3', '']) {
      expect(ok(spec), spec).toMatchObject({ ok: false });
    }
  });

  it('refuses when package.json asks for a different minor or a newer patch than the update', () => {
    expect(ok('^1.1.0')).toMatchObject({ ok: false });
    expect(ok('^1.2.9')).toMatchObject({ ok: false, why: expect.stringContaining('newer patch') });
  });

  it('reads where a package is listed', () => {
    const pkg = { dependencies: { a: '1.0.0' }, devDependencies: { a: '^1.0.0', b: '2.0.0' }, peerDependencies: { c: '*' } };
    expect(sectionsOf(pkg, 'a')).toEqual({ sections: ['dependencies', 'devDependencies'], spec: '^1.0.0' });
    expect(sectionsOf(pkg, 'b')).toEqual({ sections: ['devDependencies'], spec: '2.0.0' });
    expect(sectionsOf(pkg, 'zzz')).toEqual({ sections: [], spec: '' });
  });

  it('changes only that one line of package.json', () => {
    const text = '{\n  "name": "x",\n\t"devDependencies": {\n    "tool": "^1.2.3",\n    "other": "^1.2.3"\n  }\n}\n';
    expect(editSpec(text, 'tool', '^1.2.3', '^1.2.7')).toBe(text.replace('"tool": "^1.2.3"', '"tool": "^1.2.7"'));
    expect(editSpec(text, 'tool', '^9.9.9', '^1.2.7')).toBeNull();
    expect(editSpec('{"devDependencies":{"tool":"1.0.0"},"overrides":{"tool":"1.0.0"}}', 'tool', '1.0.0', '1.0.1')).toBeNull();
  });
});

describe('maintenance settings', () => {
  it('are off by default and checked', () => {
    expect(DEFAULT_SETTINGS.maintenance).toEqual({ patchUpdates: false });
    expect(checkSettings({}).maintenance).toEqual({ patchUpdates: false });
    expect(checkSettings({ maintenance: {} }).maintenance).toEqual({ patchUpdates: false });
    expect(checkSettings({ maintenance: { patchUpdates: true } }).maintenance).toEqual({ patchUpdates: true });
    expect(() => checkSettings({ maintenance: { patchUpdates: 'yes' } })).toThrow('Dev-tool patch updates must be on or off');
    expect(() => checkSettings({ maintenance: { patchUpdates: 1 } })).toThrow('Dev-tool patch updates must be on or off');
    expect(() => checkSettings({ maintenance: [] })).toThrow('maintenance must be an object');
    expect(() => checkSettings({ maintenance: true })).toThrow('maintenance must be an object');
  });
});

describe('maintenance setting in history and the engine', () => {
  it('a change is described in plain words and settings_check keeps it', async () => {
    const on = checkSettings({ maintenance: { patchUpdates: true } });
    expect(describeSettingsChange(DEFAULT_SETTINGS, on)).toBe('Dev-tool patch updates by the app on');
    expect(describeSettingsChange(on, DEFAULT_SETTINGS)).toBe('Dev-tool patch updates by the app off');
    const reply = JSON.parse(await handleLine(JSON.stringify({ id: 1, method: 'settings_check', params: { settings: { maintenance: { patchUpdates: true } } } })));
    expect(reply.result.maintenance).toEqual({ patchUpdates: true });
    const bad = JSON.parse(await handleLine(JSON.stringify({ id: 2, method: 'settings_check', params: { settings: { maintenance: { patchUpdates: 'on' } } } })));
    expect(bad.error).toBe('Dev-tool patch updates must be on or off');
  });
});

describe('a maintenance run', () => {
  let root = '';
  let code = '';
  let db = '';
  let installs: { cmd: string; args: string[]; cwd: string }[] = [];
  let tests: string[] = [];
  let found_: UpdateFound[] = [];
  let behaviour: { testCode?: number; installCode?: number; stray?: boolean } = {};
  const settings = (on = true) => checkSettings({ codeFolders: { 'club-hr': code }, maintenance: { patchUpdates: on } });

  /** A fake package manager: install edits the lock file; test passes or fails as told. Nothing touches a network. */
  const exec: Exec = async (cmd, args, cwd) => {
    if (args[0] === 'install') {
      installs.push({ cmd, args, cwd });
      if (behaviour.installCode) return { code: behaviour.installCode, output: 'ERR_PNPM_FETCH_404 not found' };
      const lock = join(cwd, 'pnpm-lock.yaml');
      await writeFile(lock, `${await readFile(lock, 'utf8')}# updated ${(await readFile(join(cwd, 'package.json'), 'utf8')).length}\n`);
      await mkdir(join(cwd, 'node_modules'), { recursive: true });
      if (behaviour.stray) await writeFile(join(cwd, 'surprise.txt'), 'x');
      return { code: 0, output: 'done' };
    }
    tests.push(cwd);
    return behaviour.testCode ? { code: 1, output: 'FAIL 1 test failed\nExpected 1 to be 2' } : { code: 0, output: 'ok' };
  };
  const green: MaintenanceOptions['freeChecks'] = async () => [{ name: 'secrets', passed: true, free: true }, { name: 'audit', passed: true, free: true }] as CheckResult[];
  const opts = (more: MaintenanceOptions = {}): MaintenanceOptions => ({ now: NOW, exec, freeChecks: green, find: async () => found_, ...more });
  const head = () => git(code, 'rev-parse', 'HEAD').trim();
  const branches = () => git(code, 'branch', '--format=%(refname:short)').trim().split('\n');
  const worktrees = () => git(code, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'aip-maint-')));
    code = join(root, 'club-hr');
    db = join(root, 'history.sqlite');
    installs = [];
    tests = [];
    behaviour = {};
    found_ = [found('tool-a', '1.2.3', '1.2.5')];
    execFileSync('git', ['init', '-q', '-b', 'main', code]);
    for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(code, 'config', k!, v!);
    await writeFile(join(code, 'package.json'), JSON.stringify({ name: 'club-hr', scripts: { test: 'node t.js' }, dependencies: { 'dep-x': '^2.0.0' }, devDependencies: { 'tool-a': '^1.2.3', 'tool-b': '~3.4.0', 'tool-c': '^0.5.1', 'tool-d': '^1.0.0', 'tool-e': '1.0.0', 'tool-f': '^1.0.0' } }, null, 2) + '\n');
    await writeFile(join(code, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    await writeFile(join(code, '.gitignore'), 'node_modules/\n');
    git(code, 'add', '.');
    git(code, 'commit', '-q', '-m', 'first');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('does nothing at all when the setting is off (the default)', async () => {
    let looked = false;
    const before = head();
    const r = await runMaintenance(checkSettings({ codeFolders: { 'club-hr': code } }), 'club-hr', db, opts({ find: async () => { looked = true; return found_; } }));
    expect(r).toEqual({ ran: false, slug: 'club-hr', summary: OFF_TEXT, items: [], githubNote: '' });
    expect(looked).toBe(false);
    expect(installs).toEqual([]);
    expect(worktrees()).toBe(1);
    expect(branches()).toEqual(['main']);
    expect(head()).toBe(before);
    expect(await exists(join(root, 'club-hr-runs'))).toBe(false);
    expect(RunLog.open(db).list()).toEqual([]);
  });

  it('the engine method also does nothing when off', async () => {
    const reply = JSON.parse(await handleLine(JSON.stringify({ id: 1, method: 'maintenance_run', params: { settings: { codeFolders: { 'club-hr': code } }, slug: 'club-hr', dbPath: db } })));
    expect(reply.result).toMatchObject({ ran: false, summary: OFF_TEXT });
    expect(JSON.parse(await handleLine(JSON.stringify({ id: 2, method: 'maintenance_run', params: { settings: {}, dbPath: db } }))).error).toBe('slug is required');
  });

  it('green: leaves a waiting item, joshua’s branch untouched, installs with --ignore-scripts, says GitHub is not available', async () => {
    const before = head();
    const manifest = await readFile(join(code, 'package.json'), 'utf8');
    const r = await runMaintenance(settings(), 'club-hr', db, opts());
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ package: 'tool-a', from: '1.2.3', to: '1.2.5', outcome: 'waiting' });
    expect(r.githubNote).toBe(GITHUB_UNAVAILABLE);
    expect(r.items[0]!.detail).toContain(GITHUB_UNAVAILABLE);
    expect(r.summary).toContain(GITHUB_UNAVAILABLE);
    expect(r.summary).toContain('Nothing was merged or pushed.');
    expect(r.summary).toContain('£0.00 ($0.00)');

    // the install: package manager from the lock file, no package scripts, in the copy only
    expect(installs).toHaveLength(1);
    expect(installs[0]!.cmd).toBe('pnpm');
    expect(installs[0]!.args).toEqual(expect.arrayContaining([...INSTALL_ARGS]));
    expect(installs[0]!.args).toContain('--ignore-scripts');
    expect(installs[0]!.cwd).not.toBe(code);
    expect(tests).toEqual([installs[0]!.cwd]);

    // joshua's copy and branch: untouched
    expect(head()).toBe(before);
    expect(await readFile(join(code, 'package.json'), 'utf8')).toBe(manifest);
    expect(await readFile(join(code, 'pnpm-lock.yaml'), 'utf8')).toBe('lockfileVersion: 9\n');
    expect(git(code, 'status', '--porcelain').trim()).toBe('');
    expect(git(code, 'branch', '--merged', 'main', '--format=%(refname:short)').trim().split('\n')).toContain('main');

    // the waiting item: a build-like row, its own branch with one commit, only the manifest and lock file changed
    const run = RunLog.open(db).get(r.items[0]!.runId!)!;
    expect(run).toMatchObject({ status: 'built', slug: 'club-hr', feature: 'Maintenance: tool-a 1.2.3 → 1.2.5', model: MAINTENANCE_MODEL, testsPassed: true, costUsd: 0, base: before });
    expect(run.branch).toMatch(/^aip\/maint-tool-a-20261112-100000$/);
    expect(await exists(run.path)).toBe(true);
    expect(git(code, 'rev-list', '--count', `${before}..${run.branch}`).trim()).toBe('1');
    expect(git(code, 'diff', '--name-only', before, run.branch).trim().split('\n').sort()).toEqual(['package.json', 'pnpm-lock.yaml']);
    expect(git(code, 'show', `${run.branch}:package.json`)).toContain('"tool-a": "^1.2.5"');
    expect(git(run.path, 'status', '--porcelain').trim()).toBe('');
  });

  it('green: Keep merges it with --no-ff and Undo reverses it with a new commit, like any build', async () => {
    const r = await runMaintenance(settings(), 'club-hr', db, opts());
    const id = r.items[0]!.runId!;
    const before = head();
    const kept = await keepRun(settings(), db, id, NOW);
    expect(kept.note).toMatch(/^Kept Maintenance: tool-a 1\.2\.3 → 1\.2\.5 in your copy on main\. Nothing was pushed\.$/);
    expect(git(code, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3); // a merge commit
    expect(git(code, 'log', '-1', '--format=%s').trim()).toMatch(/^Keep Maintenance: tool-a 1\.2\.3 → 1\.2\.5 \(build aip\/maint-tool-a-/);
    expect(await readFile(join(code, 'package.json'), 'utf8')).toContain('"tool-a": "^1.2.5"');
    expect(await exists(RunLog.open(db).get(id)!.path)).toBe(false);

    const undone = await revertKept(settings(), db, id, NOW);
    expect(undone.note).toContain('a new commit on main reverses it');
    expect(await readFile(join(code, 'package.json'), 'utf8')).toContain('"tool-a": "^1.2.3"');
    expect(git(code, 'merge-base', '--is-ancestor', before, 'HEAD')).toBe(''); // history was not rewritten
    expect(RunLog.open(db).get(id)!.status).toBe('reverted');
  });

  it('green with GitHub readable: the branch status must be green, and it is said so', async () => {
    const r = await runMaintenance(settings(), 'club-hr', db, opts({ githubStatus: async () => 'green' }));
    expect(r.items[0]!.outcome).toBe('waiting');
    expect(r.githubNote).toBe('GitHub checks green');
    expect(r.summary).not.toContain(GITHUB_UNAVAILABLE);
  });

  it('GitHub red or still running: rolled back even though local checks pass', async () => {
    for (const state of ['red', 'pending'] as const) {
      const r = await runMaintenance(settings(), 'club-hr', db, opts({ githubStatus: async () => state, now: new Date(NOW.getTime() + (state === 'red' ? 0 : 60_000)) }));
      expect(r.items[0]).toMatchObject({ outcome: 'rolled back' });
      expect(r.items[0]!.detail).toContain('GitHub’s checks for the branch are');
      expect(worktrees()).toBe(1);
      expect(branches()).toEqual(['main']);
      found_ = [found('tool-a', '1.2.3', '1.2.6')]; // a newer version, so it is tried again
    }
  });

  it('a GitHub lookup that throws counts as not available, not as red', async () => {
    const r = await runMaintenance(settings(), 'club-hr', db, opts({ githubStatus: async () => { throw new Error('offline'); } }));
    expect(r.items[0]!.outcome).toBe('waiting');
    expect(r.githubNote).toBe(GITHUB_UNAVAILABLE);
  });

  it('failing tests: rolled back, copy and branch gone, failure recorded, nothing reached joshua’s branch', async () => {
    behaviour = { testCode: 1 };
    const before = head();
    const r = await runMaintenance(settings(), 'club-hr', db, opts());
    expect(r.items[0]).toMatchObject({ package: 'tool-a', outcome: 'rolled back' });
    expect(r.items[0]!.detail).toContain('The tests failed with tool-a 1.2.5');
    expect(r.items[0]!.detail).toContain('Rolled back: nothing reached your branch.');
    expect(worktrees()).toBe(1);
    expect(branches()).toEqual(['main']);
    expect(await exists(join(root, 'club-hr-runs', 'maint-tool-a-20261112-100000'))).toBe(false);
    expect(head()).toBe(before);
    expect(git(code, 'status', '--porcelain').trim()).toBe('');
    expect(await readFile(join(code, 'package.json'), 'utf8')).toContain('"tool-a": "^1.2.3"');

    const run = RunLog.open(db).get(r.items[0]!.runId!)!;
    expect(run).toMatchObject({ status: 'failed', cause: 'tool', model: MAINTENANCE_MODEL, feature: 'Maintenance: tool-a 1.2.3 → 1.2.5' });
    expect(run.error).toContain('The tests failed');
    expect(run.decidedAt).not.toBeNull(); // already cleaned: no Undo offered
    expect(r.summary).toContain('0 dev-tool patch updates ready for your Keep in Build, 1 rolled back');
    expect(r.summary).toContain('Nothing reached your branch.');

    // the same failed version isn't tried again; a newer one is
    const again = await runMaintenance(settings(), 'club-hr', db, opts({ now: new Date(NOW.getTime() + 60_000) }));
    expect(again.items[0]).toMatchObject({ outcome: 'skipped' });
    expect(again.items[0]!.detail).toContain('already tried');
    expect(installs).toHaveLength(1);
  });

  it('a failed install, a failed free check, and a stray changed file are all rolled back', async () => {
    behaviour = { installCode: 1 };
    let r = await runMaintenance(settings(), 'club-hr', db, opts());
    expect(r.items[0]).toMatchObject({ outcome: 'rolled back' });
    expect(r.items[0]!.detail).toContain('Installing failed');

    behaviour = {};
    found_ = [found('tool-a', '1.2.3', '1.2.6')];
    r = await runMaintenance(settings(), 'club-hr', db, opts({ now: new Date(NOW.getTime() + 60_000), freeChecks: async () => [{ name: 'secrets', passed: false, free: true, detail: 'a key' }] }));
    expect(r.items[0]!.detail).toContain('These checks didn’t pass: secrets.');

    found_ = [found('tool-a', '1.2.3', '1.2.7')];
    behaviour = { stray: true };
    r = await runMaintenance(settings(), 'club-hr', db, opts({ now: new Date(NOW.getTime() + 120_000) }));
    expect(r.items[0]!.detail).toContain('changed files it shouldn’t (surprise.txt)');

    expect(worktrees()).toBe(1);
    expect(branches()).toEqual(['main']);
    expect(git(code, 'status', '--porcelain').trim()).toBe('');
  });

  it('only devDependencies are updated; everything else is left to joshua with the reason', async () => {
    found_ = [
      found('dep-x', '2.0.0', '2.0.4'), // a real dependency
      found('tool-b', '3.4.0', '3.5.0'), // minor
      found('tool-c', '0.5.1', '1.0.0'), // major
      found('tool-d', '1.0.0', '1.0.1-beta.2'), // pre-release
      found('tool-e', '1.0.0', '1.0.1'), // exact pin: fine
      found('not-listed', '1.0.0', '1.0.1'), // not at the top of package.json
      { ...found('tool-f', '1.0.0', '1.0.1'), level: 'patch' },
    ];
    const r = await runMaintenance(settings(), 'club-hr', db, opts());
    const by = Object.fromEntries(r.items.map((i) => [i.package, i]));
    expect(by['dep-x']).toMatchObject({ outcome: 'skipped' });
    expect(by['dep-x']!.detail).toContain('isn’t a dev tool');
    expect(by['tool-b']!.detail).toContain('minor');
    expect(by['tool-c']!.detail).toContain('major');
    expect(by['tool-d']!.detail).toContain('pre-release');
    expect(by['not-listed']!.detail).toContain('isn’t listed at the top of package.json');
    expect(by['tool-e']!.outcome).toBe('waiting');
    expect(by['tool-f']!.outcome).toBe('waiting');
    expect(installs).toHaveLength(2);
    expect(git(code, 'show', `${RunLog.open(db).get(by['tool-e']!.runId!)!.branch}:package.json`)).toContain('"tool-e": "1.0.1"');
    expect(git(code, 'show', `${RunLog.open(db).get(by['tool-e']!.runId!)!.branch}:package.json`)).toContain('"dep-x": "^2.0.0"');
  });

  it(`does at most ${MAX_PER_RUN} updates per run and tells joshua the rest come next time`, async () => {
    found_ = ['a', 'b', 'c', 'd', 'e'].map((x) => found(`tool-${x}`, x === 'a' ? '1.2.3' : x === 'b' ? '3.4.0' : x === 'c' ? '0.5.1' : x === 'd' ? '1.0.0' : '1.0.0', x === 'a' ? '1.2.4' : x === 'b' ? '3.4.1' : x === 'c' ? '0.5.2' : x === 'd' ? '1.0.1' : '1.0.1'));
    const r = await runMaintenance(settings(), 'club-hr', db, opts());
    expect(r.items.filter((i) => i.outcome === 'waiting')).toHaveLength(3);
    expect(installs).toHaveLength(3);
    expect(r.summary).toContain('2 more patch updates will be tried next run (at most 3 per run).');
    // the next run picks up the other two (the first three now wait; they are not repeated)
    const next = await runMaintenance(settings(), 'club-hr', db, opts({ now: new Date(NOW.getTime() + 60_000) }));
    expect(next.items.filter((i) => i.outcome === 'waiting').map((i) => i.package).sort()).toEqual(['tool-d', 'tool-e']);
    expect(next.items.filter((i) => i.outcome === 'skipped')).toHaveLength(3);
    expect(installs).toHaveLength(5);
  });

  it('one update at a time, each in its own copy, never two waiting for the same package', async () => {
    const first = await runMaintenance(settings(), 'club-hr', db, opts());
    found_ = [found('tool-a', '1.2.3', '1.2.9')];
    const second = await runMaintenance(settings(), 'club-hr', db, opts({ now: new Date(NOW.getTime() + 60_000) }));
    expect(first.items[0]!.outcome).toBe('waiting');
    expect(second.items[0]).toMatchObject({ outcome: 'skipped' });
    expect(second.items[0]!.detail).toContain('still waiting in Build');
    expect(installs).toHaveLength(1);
  });

  it('yarn projects are left to joshua; nothing is created', async () => {
    await rm(join(code, 'pnpm-lock.yaml'));
    await writeFile(join(code, 'yarn.lock'), '# yarn\n');
    git(code, 'add', '-A');
    git(code, 'commit', '-q', '-m', 'yarn');
    const r = await runMaintenance(settings(), 'club-hr', db, opts());
    expect(r.items[0]).toMatchObject({ outcome: 'skipped' });
    expect(r.items[0]!.detail).toContain('yarn');
    expect(installs).toEqual([]);
    expect(worktrees()).toBe(1);
  });

  it('says so plainly when updates can’t be looked up, and changes nothing', async () => {
    const r = await runMaintenance(settings(), 'club-hr', db, opts({ find: async () => { throw new Error('offline'); } }));
    expect(r.summary).toBe('Couldn’t look for updates in club-hr: offline Nothing was changed.');
    expect(worktrees()).toBe(1);
  });

  it('never marks a maintenance item as a build model in habits or comparisons', async () => {
    const r = await runMaintenance(settings(), 'club-hr', db, opts());
    await keepRun(settings(), db, r.items[0]!.runId!, NOW);
    const runs = RunLog.open(db).list();
    expect(workflowStats(runs)).toEqual([]);
    const many = Array.from({ length: 6 }, (_, i) => ({ ...runs[0]!, id: 100 + i }));
    expect(learnHabits(many, (m) => m)).toEqual([]);
  });
});

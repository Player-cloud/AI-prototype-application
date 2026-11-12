import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunLog } from '@aip/memory';
import { HINT_MAX, MAX_FILES, cleanPath, emptyMap, isTestPath, mapHint, refreshMap, type ProjectMap } from '../src/project-map.ts';
import { handleLine } from '../src/protocol.ts';

const NOW = new Date('2026-11-12T09:00:00Z');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
const always = async () => true;
const build = (changed: string[], feature = 'F-01') => ({ feature, title: 'Login', buildId: 7, keptAt: NOW.toISOString(), changed });

describe('project map: paths and tests', () => {
  it('stores repo-relative forward-slash paths, also when they arrive with Windows backslashes', async () => {
    expect(await cleanPath('src\\pages\\Login.tsx')).toBe('src/pages/Login.tsx');
    expect(await cleanPath('.\\src\\a.ts')).toBe('src/a.ts');
    const map = await refreshMap(emptyMap(), build(['src\\login\\Login.tsx', 'tests\\login.test.ts']), always);
    expect(map.features['F-01']!.files).toEqual(['src/login/Login.tsx', 'tests/login.test.ts']);
  });

  it('rejects paths outside the project and absolute paths', async () => {
    for (const bad of ['../outside.ts', 'src/../../x.ts', '/etc/passwd', 'C:\\Users\\joshua\\a.ts', 'C:/a.ts', '\\\\server\\share\\a.ts', '', '.git/config']) {
      expect(await cleanPath(bad), bad).toBeNull();
    }
  });

  it('never stores key-like files', async () => {
    for (const bad of ['.env', 'app/.env.local', 'certs/server.pem', 'keys/id_rsa', 'a/b.key']) expect(await cleanPath(bad), bad).toBeNull();
    expect(await cleanPath('.env.example')).toBe('.env.example');
    const map = await refreshMap(emptyMap(), build(['.env', 'src/a.ts', 'x/cert.pem']), always);
    expect(map.features['F-01']!.files).toEqual(['src/a.ts']);
  });

  it('tells tests from other files', () => {
    for (const t of ['a.test.ts', 'src/a.spec.tsx', 'tests/helper.ts', 'pkg/__tests__/a.js', 'test/x.ts']) expect(isTestPath(t), t).toBe(true);
    for (const f of ['src/a.ts', 'src/contest.ts', 'latest/a.ts', 'README.md']) expect(isTestPath(f), f).toBe(false);
  });
});

describe('project map: refresh', () => {
  it('splits files and tests, and adds to the feature over later builds', async () => {
    const first = await refreshMap(emptyMap(), build(['src/Login.tsx', 'src/Login.test.tsx']), always);
    expect(first.features['F-01']).toMatchObject({ title: 'Login', files: ['src/Login.tsx', 'src/Login.test.tsx'], tests: ['src/Login.test.tsx'], lastBuildId: 7 });
    const second = await refreshMap(first, { ...build(['src/Session.ts']), buildId: 9 }, always);
    expect(second.features['F-01']).toMatchObject({ files: ['src/Login.tsx', 'src/Login.test.tsx', 'src/Session.ts'], tests: ['src/Login.test.tsx'], lastBuildId: 9 });
  });

  it('drops files that no longer exist in the project, in every feature', async () => {
    const base: ProjectMap = { version: 1, updatedAt: null, features: { 'F-02': { title: 'Rota', files: ['a.ts', 'gone.ts', 'gone.test.ts'], tests: ['gone.test.ts'], lastBuildId: 1, lastKeptAt: 'x' } } };
    const map = await refreshMap(base, build(['src/new.ts']), async (p) => !p.startsWith('gone'));
    expect(map.features['F-02']).toMatchObject({ files: ['a.ts'], tests: [] });
    expect(map.features['F-01']!.files).toEqual(['src/new.ts']);
  });

  it('caps the files per feature, keeping the newest, with a note', async () => {
    const many = Array.from({ length: MAX_FILES + 25 }, (_, i) => `src/f${i}.ts`);
    const map = await refreshMap(emptyMap(), build(many), always);
    const e = map.features['F-01']!;
    expect(e.files).toHaveLength(MAX_FILES);
    expect(e.files.at(-1)).toBe(`src/f${MAX_FILES + 24}.ts`);
    expect(e.note).toContain('25 older ones left out');
  });

  it('makes a short, capped hint for a build prompt, and none for a new feature', () => {
    expect(mapHint(undefined)).toBe('');
    const files = Array.from({ length: HINT_MAX + 12 }, (_, i) => `src/f${i}.ts`);
    const hint = mapHint({ title: 'Login', files, tests: [], lastBuildId: 1, lastKeptAt: 'x' });
    expect(hint.split('\n').filter((l) => l.startsWith('- src/'))).toHaveLength(HINT_MAX);
    expect(hint).toContain('- …and 12 more');
  });
});

describe('project map: Keep and the engine command', () => {
  let root = '';
  let code = '';
  let data = '';
  let db = '';
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'aip-map-')));
    code = join(root, 'club-hr');
    data = join(root, 'data');
    db = join(root, 'history.sqlite');
    await mkdir(data);
    execFileSync('git', ['init', '-q', '-b', 'main', code]);
    git(code, 'config', 'user.name', 'Test');
    git(code, 'config', 'user.email', 'test@example.invalid');
    git(code, 'config', 'commit.gpgsign', 'false');
    git(code, 'config', 'core.autocrlf', 'false');
    await writeFile(join(code, 'README.md'), '# Club HR\n');
    await writeFile(join(code, 'old.ts'), 'old\n');
    git(code, 'add', '.');
    git(code, 'commit', '-q', '-m', 'first');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function built(files: Record<string, string>, feature = 'F-01') {
    const branch = `aip/${feature.toLowerCase()}-20261112-090000`;
    const path = join(root, 'runs', `${feature}-20261112-090000`);
    git(code, 'worktree', 'add', '-q', '-b', branch, path, 'HEAD');
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(path, name, '..'), { recursive: true });
      await writeFile(join(path, name), text);
    }
    const log = RunLog.open(db);
    const id = log.add({ at: NOW, slug: 'club-hr', feature, path, branch, base: git(code, 'rev-parse', 'HEAD').trim(), model: 'claude-sonnet-5-5', costUsd: 0.1, testsPassed: true, fixAttempts: 0, summary: 'Done.', checks: [] });
    log.close();
    return id;
  }
  const call = async (method: string, params: Record<string, unknown>) => JSON.parse(await handleLine(JSON.stringify({ id: 1, method, params }), { now: () => NOW, modelName: async (id: string) => id } as never));
  const mapPath = () => join(data, 'projects', 'club-hr', 'map.json');

  it('writes the map after Keep with files and tests split, never key files', async () => {
    const id = await built({ 'src/Login.tsx': 'x', 'src/Login.test.tsx': 'x', '.env': 'KEY=1', 'certs/a.pem': 'x' });
    const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    const r = await call('run_keep', { settings, dbPath: db, id });
    expect(r.error).toBeUndefined();
    expect(r.result.note).toBe('Kept F-01 in your copy on main. Nothing was pushed.');
    const map = JSON.parse(await readFile(mapPath(), 'utf8'));
    expect(map).toMatchObject({ version: 1, updatedAt: NOW.toISOString() });
    expect(map.features['F-01']).toMatchObject({ title: 'F-01', files: ['src/Login.test.tsx', 'src/Login.tsx'], tests: ['src/Login.test.tsx'], lastBuildId: id, lastKeptAt: NOW.toISOString() });
    expect(JSON.stringify(map)).not.toMatch(/\\|\.env|\.pem|:\//);
    // The engine command returns it.
    expect((await call('project_map', { settings, project: 'club-hr' })).result).toEqual(map);
  });

  it('drops deleted files on the next refresh', async () => {
    const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    const a = await built({ 'src/a.ts': 'a' });
    await call('run_keep', { settings, dbPath: db, id: a });
    git(code, 'rm', '-q', 'src/a.ts');
    git(code, 'commit', '-q', '-m', 'remove a');
    const b = await built({ 'src/b.ts': 'b' }, 'F-01');
    expect((await call('run_keep', { settings, dbPath: db, id: b })).error).toBeUndefined();
    expect(JSON.parse(await readFile(mapPath(), 'utf8')).features['F-01'].files).toEqual(['src/b.ts']);
  });

  it('a map that can’t be written never fails Keep, and says so', async () => {
    const notAFolder = join(root, 'data-file');
    await writeFile(notAFolder, 'x');
    const id = await built({ 'src/a.ts': 'a' });
    const r = await call('run_keep', { settings: { dataFolder: notAFolder, codeFolders: { 'club-hr': code } }, dbPath: db, id });
    expect(r.error).toBeUndefined();
    expect(r.result.run.status).toBe('kept');
    expect(r.result.note).toMatch(/^Kept F-01 in your copy on main\. Nothing was pushed\. The project map wasn’t updated \(/);
  });

  it('project_map gives an empty map when there is none', async () => {
    const r = await call('project_map', { settings: { dataFolder: data }, project: 'club-hr' });
    expect(r.result).toEqual({ version: 1, updatedAt: null, features: {} });
    expect((await call('project_map', { settings: { dataFolder: data }, project: '../x' })).error).toBeDefined();
  });
});

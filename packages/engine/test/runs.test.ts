import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkCodeFolder, parseWorktrees, stamp, startRun } from '../src/runs.ts';
import { checkSettings } from '../src/settings.ts';
import { handleLine } from '../src/protocol.ts';

const NOW = new Date('2026-11-11T16:05:09Z');
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

describe('run names', () => {
  it('stamps runs to the second, in UTC', () => {
    expect(stamp(NOW)).toBe('20261111-160509');
  });

  it('lists only the app’s feature runs', () => {
    const porcelain = [
      'worktree /code/club-hr\nHEAD abc\nbranch refs/heads/main',
      'worktree /code/club-hr-runs/F-01-20261111-160509\nHEAD abc\nbranch refs/heads/aip/f-01-20261111-160509',
      'worktree /tmp/other\nHEAD def\nbranch refs/heads/joshua-test',
      'worktree /tmp/detached\nHEAD def\ndetached',
    ].join('\n\n');
    expect(parseWorktrees(porcelain)).toEqual([
      { path: '/code/club-hr-runs/F-01-20261111-160509', branch: 'aip/f-01-20261111-160509', feature: 'F-01' },
    ]);
  });
});

describe('feature runs in git worktrees', () => {
  let root = '';
  let code = '';
  let data = '';
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'aip-runs-')));
    code = join(root, 'club-hr');
    data = join(root, 'data');
    await mkdir(code);
    await mkdir(data);
    git(code, 'init', '-q', '-b', 'main');
    git(code, 'config', 'core.autocrlf', 'false'); // Windows runners turn LF into CRLF on checkout otherwise
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function finishedPlan(settings: Record<string, unknown>) {
    const call = async (method: string, params: Record<string, unknown>) =>
      JSON.parse(await handleLine(JSON.stringify({ id: 1, method, params })));
    await call('interview_start', { settings, name: 'Club HR' });
    const patches: Record<string, Record<string, unknown>> = {
      idea: { text: { 'idea.what': 'HR' } },
      audience: { text: { 'audience.who': 'Staff', 'audience.goals': 'Shifts' } },
      features: { features: [{ name: 'Login' }] },
      checklist: { areas: [] },
      look: { text: { 'look.feel': 'Calm' } },
      tech: {},
      done: { done: { 'F-01': ['Works'] } },
    };
    for (const [stage, patch] of Object.entries(patches)) {
      await call('interview_save', { settings, slug: 'club-hr', stage, patch });
      await call('interview_confirm', { settings, slug: 'club-hr', stage });
    }
    return call;
  }

  it('explains what’s wrong with a code folder in plain words', async () => {
    await expect(checkCodeFolder(join(root, 'nope'))).rejects.toThrow('Can’t find the folder');
    await expect(checkCodeFolder(data)).rejects.toThrow('isn’t a git repo');
    await expect(checkCodeFolder(code)).rejects.toThrow('no commits yet');
    await writeFile(join(code, 'README.md'), '# Club HR\n');
    git(code, 'add', '.');
    git(code, 'commit', '-q', '-m', 'first');
    await mkdir(join(code, 'src'));
    await expect(checkCodeFolder(join(code, 'src'))).rejects.toThrow('Choose the top of the repo');
    expect(await checkCodeFolder(code)).toEqual({ folder: code, branch: 'main', clean: true, runs: [] });
  });

  it('starts each feature run in its own copy, leaving joshua’s copy alone', async () => {
    await writeFile(join(code, 'README.md'), '# Club HR\n');
    git(code, 'add', '.');
    git(code, 'commit', '-q', '-m', 'first');
    await writeFile(join(code, 'notes.txt'), 'not committed'); // joshua's own work in progress

    const settings = checkSettings({ dataFolder: data, codeFolders: { 'club-hr': code } });
    const call = await finishedPlan(settings);

    await expect(startRun(settings, 'club-hr', 'F-09', NOW)).rejects.toThrow('There’s no F-09');
    await expect(startRun(settings, 'club-hr', '../x', NOW)).rejects.toThrow('isn’t a feature ID');
    await expect(startRun(checkSettings({ dataFolder: data }), 'club-hr', 'F-01', NOW)).rejects.toThrow('Set this project’s code folder first');

    const run = await startRun(settings, 'club-hr', 'F-01', NOW);
    expect(run).toMatchObject({ feature: 'F-01', branch: 'aip/f-01-20261111-160509', path: join(root, 'club-hr-runs', 'F-01-20261111-160509') });
    expect(await readFile(join(run.path, 'README.md'), 'utf8')).toBe('# Club HR\n');
    // The run starts from the last commit, without joshua's uncommitted file.
    await expect(readFile(join(run.path, 'notes.txt'), 'utf8')).rejects.toThrow();
    expect(git(code, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');

    // A second run of the same feature a second later is a new copy; the same second is refused.
    await expect(startRun(settings, 'club-hr', 'F-01', NOW)).rejects.toThrow('Couldn’t make a separate copy for F-01');

    const r = (await call('code_folder_check', { settings, slug: 'club-hr' })).result;
    expect(r).toMatchObject({ branch: 'main', clean: false });
    expect(r.runs).toEqual([{ path: run.path.split('\\').join('/'), branch: run.branch, feature: 'F-01' }]);
    expect((await call('code_folder_check', { settings: { dataFolder: data }, slug: 'club-hr' })).error).toBe(
      'Set this project’s code folder first: where its repo is cloned on this computer.',
    );
  });
});

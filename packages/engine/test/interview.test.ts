import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleLine, realDeps } from '../src/protocol.ts';
import {
  STAGES,
  applyPatch,
  bigBuild,
  checkInterview,
  confirmStage,
  missing,
  newInterview,
  renderSpec,
  toolsForStage,
} from '../src/interview.ts';

const NOW = new Date('2026-11-11T14:30:00Z');

describe('the interview rules', () => {
  it('has the seven stages in the planned order', () => {
    expect(STAGES.map((s) => s.id)).toEqual(['idea', 'audience', 'features', 'checklist', 'look', 'tech', 'done']);
  });

  it('gives features fixed IDs that are never reused', () => {
    let iv = newInterview('Club HR', 'club-hr', NOW);
    iv = applyPatch(iv, { features: [{ name: 'Login' }, { name: 'Rota', what: 'Weekly shifts' }, { name: '  ' }] });
    expect(iv.features.map((f) => [f.id, f.name])).toEqual([
      ['F-01', 'Login'],
      ['F-02', 'Rota'],
    ]);
    // Remove F-01, rename F-02, add one: the new feature gets F-03, not F-01.
    iv = applyPatch(iv, { features: [{ id: 'F-02', name: 'Shift rota' }, { name: 'Payslips' }] });
    expect(iv.features.map((f) => [f.id, f.name])).toEqual([
      ['F-02', 'Shift rota'],
      ['F-03', 'Payslips'],
    ]);
    // Remove F-03 and save; the next new feature still gets F-04. A made-up ID can't be claimed.
    iv = applyPatch(iv, { features: [{ id: 'F-02', name: 'Shift rota' }] });
    iv = applyPatch(iv, { features: [{ id: 'F-02', name: 'Shift rota' }, { id: 'F-09', name: 'Holidays' }] });
    expect(iv.features.map((f) => f.id)).toEqual(['F-02', 'F-04']);
    expect(checkInterview(JSON.parse(JSON.stringify(iv))).lastFeature).toBe(4);
  });

  it('won’t confirm a stage until its answers are in, and says what’s missing', () => {
    const iv = newInterview('Club HR', 'club-hr', NOW);
    expect(missing(iv, 'idea')).toEqual(['Answer “What is it, in a sentence or two?”']);
    expect(() => confirmStage(iv, 'features', NOW)).toThrow('Not ready yet: Add at least one feature.');
    const ok = confirmStage(applyPatch(iv, { text: { 'idea.what': 'HR for a sports club' } }), 'idea', NOW);
    expect(ok.confirmed).toEqual(['idea']);
    expect(ok.current).toBe('audience');
  });

  it('un-confirms “done” when a feature has no done checks any more', () => {
    let iv = applyPatch(newInterview('X', 'x', NOW), { features: [{ name: 'Login' }], done: {} });
    iv = applyPatch(iv, { done: { 'F-01': 'Can sign in\n\nCan sign out' } });
    expect(iv.done['F-01']).toEqual(['Can sign in', 'Can sign out']);
    iv = { ...iv, confirmed: ['done'] };
    iv = applyPatch(iv, { features: [{ id: 'F-01', name: 'Login' }, { name: 'Rota' }] });
    expect(iv.confirmed).toEqual([]);
  });

  it('rejects unknown questions, done checks for missing features and too many features', () => {
    const iv = newInterview('X', 'x', NOW);
    expect(() => applyPatch(iv, { text: { 'idea.colour': 'red' } })).toThrow('unknown question: idea.colour');
    expect(() => applyPatch(iv, { done: { 'F-07': ['x'] } })).toThrow('no feature F-07');
    expect(() => applyPatch(iv, { features: Array.from({ length: 31 }, (_, i) => ({ name: `f${i}` })) })).toThrow(/30 features at most/);
  });

  it('calls a build big at 5 features or for logins, payments or personal data', () => {
    const iv = applyPatch(newInterview('X', 'x', NOW), { features: [{ name: 'a' }] });
    expect(bigBuild(iv)).toBe(false);
    expect(bigBuild(applyPatch(iv, { areas: ['Payments', 'Not an area'] }))).toBe(true);
    expect(bigBuild(applyPatch(iv, { features: ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name })) }))).toBe(true);
  });

  it('writes a spec with feature IDs and one pass/fail done file per feature', () => {
    let iv = newInterview('Club HR', 'club-hr', NOW);
    iv = applyPatch(iv, {
      text: { 'idea.what': 'HR for a sports club', 'audience.who': 'Club staff', 'audience.goals': 'Plan shifts', 'look.feel': 'Calm' },
      features: [{ name: 'Login', what: 'Email sign in' }, { name: 'Rota' }],
      areas: ['Logins and accounts'],
      done: { 'F-01': ['A member can sign in with email'], 'F-02': ['Staff see this week’s shifts'] },
    });
    const files = renderSpec(iv, NOW);
    expect(Object.keys(files)).toEqual(['spec.md', 'done/F-01.md', 'done/F-02.md']);
    expect(files['spec.md']).toContain('- **F-01 Login**: Email sign in (done file: done/F-01.md)');
    expect(files['spec.md']).toContain('Stack: Standard stack: Next.js + TypeScript');
    expect(files['spec.md']).toContain('Big build: yes');
    expect(files['done/F-01.md']).toBe(
      '# F-01 Login: done when\n\nEach line passes or fails. The feature is done only when every line passes.\n\n- [ ] A member can sign in with email\n',
    );
  });

  it('lists related tools for a stage, leaving out switched-off ones', () => {
    const tools = [
      { name: 'EGM', state: 'on', job: 'planning' },
      { name: 'Opus single-pass plan review', state: 'off', job: 'plan review' },
      { name: 'Only CLI (oc)', state: 'on', job: 'web reading' },
      { name: 'secretlint', state: 'on', job: 'secret scan every build' },
    ];
    expect(toolsForStage('idea', tools).map((t) => t.name)).toEqual(['EGM']);
    expect(toolsForStage('checklist', tools).map((t) => t.name)).toEqual(['secretlint']);
  });

  it('reads back a hand-edited interview safely', () => {
    const iv = checkInterview({
      version: 1,
      name: 'X',
      slug: 'x',
      current: 'nonsense',
      confirmed: ['idea', 'bogus'],
      features: [{ id: 'F-04', name: 'Kept id' }],
      done: { 'F-04': ['works'] },
    });
    expect(iv.current).toBe('idea');
    expect(iv.confirmed).toEqual(['idea']);
    expect(iv.features).toEqual([{ id: 'F-04', name: 'Kept id', what: '' }]);
    expect(() => checkInterview({ version: 2 })).toThrow('interview.json is damaged');
  });
});

describe('interview methods', () => {
  let dir = '';
  let folder = '';
  let remote = '';
  const deps = { ...realDeps, now: () => NOW };
  const call = async (method: string, params: Record<string, unknown>) =>
    JSON.parse(await handleLine(JSON.stringify({ id: 1, method, params }), deps)) as { result?: any; error?: string };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aip-interview-'));
    remote = join(dir, 'remote.git');
    folder = join(dir, 'data');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { stdio: 'pipe' });
    execFileSync('git', ['clone', '-q', remote, folder], { stdio: 'pipe' });
    git(folder, 'config', 'user.name', 'Test');
    git(folder, 'config', 'user.email', 'test@example.invalid');
    await mkdir(join(folder, 'tools'));
    await writeFile(join(folder, 'ledger.md'), '# Ledger\n\n- EGM | ON for big builds | planning | - | - | rating: -\n');
    git(folder, 'add', '-A');
    git(folder, 'commit', '-q', '-m', 'start');
    git(folder, 'push', '-q', '-u', 'origin', 'HEAD:main');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('needs a data folder', async () => {
    expect((await call('project_list', { settings: {} })).error).toBe('Set your data folder in Settings first.');
  });

  it('runs a whole interview and writes and syncs the spec', async () => {
    const settings = { dataFolder: folder };
    const started = (await call('interview_start', { settings, name: 'Club HR' })).result;
    expect(started.interview.slug).toBe('club-hr');
    expect(started.tools).toEqual([{ name: 'EGM', state: 'on', job: 'planning' }]);
    expect((await call('interview_start', { settings, name: 'club hr!' })).error).toMatch(/already a project called “club-hr”/);

    const answers: Record<string, unknown>[] = [
      { text: { 'idea.what': 'HR for a sports club' } },
      { text: { 'audience.who': 'Club staff', 'audience.goals': 'Plan shifts' } },
      { features: [{ name: 'Login' }, { name: 'Rota' }] },
      { areas: ['Logins and accounts'] },
      { text: { 'look.feel': 'Calm and simple' } },
      {},
      { done: { 'F-01': ['A member can sign in'], 'F-02': ['Staff see this week’s shifts'] } },
    ];
    let last: any;
    for (const [i, stage] of STAGES.entries()) {
      const saved = await call('interview_save', { settings, slug: 'club-hr', stage: stage.id, patch: answers[i] });
      expect(saved.error).toBeUndefined();
      expect(saved.result.missing).toEqual([]);
      last = (await call('interview_confirm', { settings, slug: 'club-hr', stage: stage.id })).result;
    }
    expect(last.view.finished).toBe(true);
    expect(last.files).toEqual(['projects/club-hr/interview.json', 'projects/club-hr/spec.md', 'projects/club-hr/done/F-01.md', 'projects/club-hr/done/F-02.md']);
    expect(last.summary).toMatch(/^Spec written: 2 features, each with a done file\. .*up to date on GitHub/);
    expect(await readFile(join(folder, 'projects', 'club-hr', 'done', 'F-02.md'), 'utf8')).toContain('- [ ] Staff see this week’s shifts');
    expect(execFileSync('git', ['log', '-1', '--format=%s', 'main'], { cwd: remote, encoding: 'utf8' }).trim()).toBe('Plan Club HR: spec with 2 features');

    expect((await call('project_list', { settings })).result).toEqual([
      { slug: 'club-hr', name: 'Club HR', status: 'Spec ready: 2 features', finished: true, updatedAt: NOW.toISOString() },
    ]);
  });

  it('refuses to save anything that looks like a key', async () => {
    const settings = { dataFolder: folder };
    await call('interview_start', { settings, name: 'Keys' });
    const r = await call('interview_save', { settings, slug: 'keys', patch: { text: { 'idea.what': 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } } });
    expect(r.error).toBe('That looks like a key. Keys go only in Settings, never in a plan.');
    expect((await call('interview_get', { settings, slug: 'keys' })).result.interview.text).toEqual({});
  });

  it('explains unknown projects and bad names', async () => {
    const settings = { dataFolder: folder };
    expect((await call('interview_get', { settings, slug: 'nope' })).error).toBe('There’s no project called “nope”.');
    expect((await call('interview_get', { settings, slug: '../x' })).error).toBe('“../x” isn’t a valid project folder name.');
    expect((await call('interview_start', { settings, name: '!!!' })).error).toBe('Use some letters or numbers in the project name.');
    expect((await call('interview_confirm', { settings, slug: 'nope', stage: 'bogus' })).error).toBe('There’s no project called “nope”.');
  });
});

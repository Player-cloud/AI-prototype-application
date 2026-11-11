import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BuildTask, ModelAdapter } from '@aip/models';
import { checkStep, runCapUsd, staysInside } from '../src/build.ts';
import { checkSettings } from '../src/settings.ts';
import { handleLine, type Deps } from '../src/protocol.ts';

// Obviously fake test value, not a real key.
const FAKE_KEY = 'sk-ant-test-0000000000000000';
const NOW = new Date('2026-11-11T17:00:00Z');
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

describe('build run rules', () => {
  it('caps a run at the Settings limit or what’s left this month', () => {
    const s = checkSettings({});
    expect(s.runCapGbp).toBe(0.8);
    expect(runCapUsd(s, null)).toBeCloseTo(0.8 / 0.79);
    expect(runCapUsd(s, 0.3)).toBe(0.3);
    expect(() => checkSettings({ runCapGbp: 0 })).toThrow('Cost limit per build run (£) must be a number from 0.05 to 50');
  });

  it('keeps every tool call inside the feature’s copy, then asks the gatekeeper', () => {
    const run = join(tmpdir(), 'club-hr-runs', 'F-01-x');
    const s = checkSettings({});
    expect(staysInside(run, { file_path: join(run, 'src', 'a.ts') })).toBe(true);
    expect(staysInside(run, { file_path: 'src/a.ts' })).toBe(true);
    expect(staysInside(run, { file_path: join(run, '..', '..', 'club-hr', 'a.ts') })).toBe(false);
    expect(staysInside(run, { path: '/etc' })).toBe(false);
    expect(staysInside(run, { command: 'pnpm test && git status' })).toBe(true);
    expect(staysInside(run, { command: `cat ${join(run, 'src', 'a.ts')}` })).toBe(true);
    expect(staysInside(run, { command: 'echo x > ../../club-hr/a.ts' })).toBe(false);
    expect(staysInside(run, { command: 'cat /etc/passwd' })).toBe(false);
    expect(staysInside(run, { command: 'ls ~/.ssh' })).toBe(false);
    expect(staysInside(run, { command: 'type C:\\Users\\joshu\\secret.txt' })).toBe(false);
    expect(checkStep(s, run, 'Edit', { file_path: '/elsewhere/a.ts' })).toEqual({ allow: false, reason: 'Only files in this feature’s own copy can be used.' });
    expect(checkStep(s, run, 'Bash', { command: 'git push origin main' })).toEqual({
      allow: false,
      reason: 'Gatekeeper (push): pushing code needs joshua\'s OK. Not done; joshua will be asked later.',
    });
    expect(checkStep(s, run, 'Read', { file_path: join(run, '.env') })).toEqual({ allow: false, reason: 'Gatekeeper (key-files): reading or writing key files is never allowed' });
    expect(checkStep(s, run, 'Bash', { command: 'pnpm test' })).toEqual({ allow: true });
  });
});

describe('build_feature', () => {
  let root = '';
  let code = '';
  let data = '';
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'aip-build-')));
    code = join(root, 'club-hr');
    data = join(root, 'data');
    await mkdir(code);
    await mkdir(data);
    git(code, 'init', '-q', '-b', 'main');
    await writeFile(join(code, 'README.md'), '# Club HR\n');
    git(code, 'add', '.');
    git(code, 'commit', '-q', '-m', 'first');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A fake agent: tries a write in its copy, a push and a write outside, then reports. */
  function deps(seen: { task?: BuildTask; maxUsd?: number; answers: unknown[] }, withBuild = true): Deps {
    const adapter: ModelAdapter = {
      provider: 'claude',
      run: async () => ({ text: '', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }),
      ...(withBuild
        ? {
            async build(task: BuildTask) {
              seen.task = task;
              const tries: [string, Record<string, unknown>][] = [
                ['Write', { file_path: join(task.cwd, 'login.md'), content: 'Login' }],
                ['Bash', { command: 'git push origin main' }],
                ['Write', { file_path: join(code, 'hack.md'), content: 'x' }],
              ];
              for (const [tool, input] of tries) {
                task.onStep?.(`${tool} ${String(input.file_path ?? input.command)}`);
                const d = await task.checkTool(tool, input);
                seen.answers.push(d);
                if (d.allow && tool === 'Write') await writeFile(String(input.file_path), String(input.content));
              }
              return { text: '  Added the login page. Tests pass.  ', usage: { inputTokens: 5000, outputTokens: 800, costUsd: 0.42 } };
            },
          }
        : {}),
    };
    return {
      async makeAdapter(_p, _k, _s, maxUsd) {
        seen.maxUsd = maxUsd;
        return adapter;
      },
      async pickModel(_p, job) {
        return job === 'build' ? 'claude-sonnet-5-5' : 'claude-opus-5-5';
      },
      async modelName() {
        return 'Sonnet 5.5';
      },
      now: () => NOW,
    };
  }

  async function plan(d: Deps, settings: Record<string, unknown>) {
    const call = async (method: string, params: Record<string, unknown>) => JSON.parse(await handleLine(JSON.stringify({ id: 1, method, params }), d));
    await call('interview_start', { settings, name: 'Club HR' });
    const patches: Record<string, Record<string, unknown>> = {
      idea: { text: { 'idea.what': 'HR' } },
      audience: { text: { 'audience.who': 'Staff', 'audience.goals': 'Shifts' } },
      features: { features: [{ name: 'Login' }] },
      checklist: { areas: [] },
      look: { text: { 'look.feel': 'Calm' } },
      tech: {},
      done: { done: { 'F-01': ['A member can sign in'] } },
    };
    for (const [stage, patch] of Object.entries(patches)) {
      await call('interview_save', { settings, slug: 'club-hr', stage, patch });
      await call('interview_confirm', { settings, slug: 'club-hr', stage });
    }
    return call;
  }

  it('builds one feature in its own copy, refusing what the gatekeeper or the copy rule stops', async () => {
    const seen = { answers: [] as unknown[] } as { task?: BuildTask; maxUsd?: number; answers: unknown[] };
    const d = deps(seen);
    const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    const call = await plan(d, settings);
    const dbPath = join(root, 'history.sqlite');

    const r = await call('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath });
    expect(r.error).toBeUndefined();
    const out = r.result;
    expect(out.using).toBe('Using: Sonnet 5.5, file edits, shell');
    expect(out.run).toMatchObject({ feature: 'F-01', branch: 'aip/f-01-20261111-170000' });
    expect(out.summary).toBe('Added the login page. Tests pass.');
    expect(out.costText).toBe('£0.33 ($0.42)');
    expect(seen.maxUsd).toBeCloseTo(0.8 / 0.79);

    // The model worked in the copy, was told the spec, and its bad steps were refused.
    expect(seen.task?.cwd).toBe(out.run.path);
    expect(seen.task?.prompt).toContain('Build feature F-01 (Login)');
    expect(seen.task?.prompt).toContain('=== done/F-01.md ===');
    expect(await readFile(join(out.run.path, 'login.md'), 'utf8')).toBe('Login');
    await expect(readFile(join(code, 'hack.md'), 'utf8')).rejects.toThrow();
    expect(seen.answers.map((a) => (a as { allow: boolean }).allow)).toEqual([true, false, false]);
    expect(out.steps.filter((s: { refused?: string }) => s.refused).map((s: { text: string }) => s.text)).toEqual(['Refused: Bash', 'Refused: Write']);

    // The cost counts against the month's budget.
    expect((await call('spend_summary', { settings, dbPath })).result.calls).toBe(1);
  });

  it('says plainly when the provider can’t build yet, before making a copy', async () => {
    const seen = { answers: [] as unknown[] };
    const d = deps(seen, false);
    const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    const call = await plan(d, settings);
    const r = await call('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'deepseek', apiKey: 'x', dbPath: null });
    expect(r.error).toBe('Building needs Claude for now. Choose Claude in Settings → Budget and models.');
    expect(git(code, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });
});

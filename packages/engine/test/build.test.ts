import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BuildTask, ModelAdapter } from '@aip/models';
import { checkStep, runCapUsd, staysInside, staysInsideReal } from '../src/build.ts';
import { checkSettings } from '../src/settings.ts';
import { handleLine, type Deps, type Live } from '../src/protocol.ts';
import { RunLog } from '@aip/memory';
import { DatabaseSync } from 'node:sqlite';

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

  it('keeps every tool call inside the feature’s copy, then asks the gatekeeper', async () => {
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
    expect(await checkStep(s, run, 'Edit', { file_path: '/elsewhere/a.ts' })).toEqual({ allow: false, reason: 'Only files in this feature’s own copy can be used.' });
    expect(await checkStep(s, run, 'Bash', { command: 'git push origin main' })).toEqual({
      allow: false,
      reason: 'Gatekeeper (push): pushing code needs joshua\'s OK. Not done.',
    });
    expect(await checkStep(s, run, 'Read', { file_path: join(run, '.env') })).toEqual({ allow: false, reason: 'Gatekeeper (key-files): reading or writing key files is never allowed' });
    expect(await checkStep(s, run, 'Bash', { command: 'pnpm test' })).toEqual({ allow: true });
    expect(await checkStep(s, run, 'Bash', { command: 'docker ps' })).toEqual({ allow: true, note: "docker isn't on the list of known build commands; it needs joshua's OK" });
  });
});

describe('ask rules and stored approvals', () => {
  let dir = '';
  let db = '';
  let run = '';
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'aip-ask-')));
    db = join(dir, 'history.sqlite');
    run = join(dir, 'run');
    await mkdir(run);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const store = (branch = 'aip/f-01-a', slug = 'club-hr') => ({ slug, feature: 'F-01', branch, dbPath: db, now: NOW });
  const approve = async (slug: string, tool: string, input: string) => {
    const m = await import('@aip/memory');
    const a = m.Asks.open(db);
    const { id } = a.add(NOW, { slug, feature: 'F-01', branch: 'b', tool, input, reason: 'r' });
    a.decide(id, true, NOW);
    a.close();
  };
  const s = checkSettings({});
  const ASK = { command: 'git push origin main' };

  it('refuses an ask and records it once; Allow once then lets exactly one through', async () => {
    const d = await checkStep(s, run, 'Bash', ASK, store());
    expect(d).toEqual({ allow: false, reason: "Gatekeeper (push): pushing code needs joshua's OK. Not done. It's in Needs you for your OK." });
    await checkStep(s, run, 'Bash', ASK, store('aip/f-01-b'));
    const m = await import('@aip/memory');
    const a = m.Asks.open(db);
    expect(a.listOpen()).toHaveLength(1);
    a.close();
    await approve('club-hr', 'Bash', ASK.command);
    expect(await checkStep(s, run, 'Bash', ASK, store('aip/f-02'))).toEqual({ allow: true });
    expect((await checkStep(s, run, 'Bash', ASK, store('aip/f-02'))).allow).toBe(false);
  });

  it('an approval for another project or an expired one does nothing', async () => {
    await approve('other', 'Bash', ASK.command);
    expect((await checkStep(s, run, 'Bash', ASK, store())).allow).toBe(false);
    await approve('club-hr', 'Bash', ASK.command);
    const later = { ...store(), now: new Date(NOW.getTime() + 25 * 3_600_000) };
    expect((await checkStep(s, run, 'Bash', ASK, later)).allow).toBe(false);
  });

  it('never overrides a never-rule, the protect-rules guard, or the own-copy check', async () => {
    const key = { file_path: join(run, '.env') };
    const guard = { file_path: join(run, 'packages', 'gatekeeper', 'src', 'index.ts'), content: 'x' };
    const outside = { file_path: '/elsewhere/a.ts' };
    await approve('club-hr', 'Read', key.file_path);
    await approve('club-hr', 'Write', guard.file_path);
    await approve('club-hr', 'Edit', outside.file_path);
    const keyD = await checkStep(s, run, 'Read', key, store());
    expect(keyD).toEqual({ allow: false, reason: 'Gatekeeper (key-files): reading or writing key files is never allowed' });
    expect((await checkStep(s, run, 'Write', guard, store())).allow).toBe(false);
    expect(await checkStep(s, run, 'Edit', outside, store())).toEqual({ allow: false, reason: 'Only files in this feature’s own copy can be used.' });
    // None of them made a request, and none of the approvals was used up.
    const m = await import('@aip/memory');
    const a = m.Asks.open(db);
    expect(a.listOpen()).toEqual([]);
    expect(a.consume('club-hr', 'Read', key.file_path, NOW, 'b')).toBe(true);
    a.close();
  });
});

describe('links inside the copy', () => {
  let base = '';
  let run = '';
  let outside = '';
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'aip-links-'));
    run = join(base, 'copy');
    outside = join(base, 'outside');
    await mkdir(join(run, 'src'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await writeFile(join(run, 'src', 'a.ts'), 'x');
    // A junction on Windows needs no admin; a plain folder link everywhere else.
    await symlink(outside, join(run, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('refuses a file reached through a link that points outside the copy', async () => {
    expect(staysInside(run, { file_path: join(run, 'link', 'secret.txt') })).toBe(true); // the words alone look fine
    expect(await staysInsideReal(run, { file_path: join(run, 'link', 'secret.txt') })).toBe(false);
    expect(await staysInsideReal(run, { file_path: 'link/secret.txt' })).toBe(false);
    expect(await staysInsideReal(run, { path: 'link' })).toBe(false);
    expect(await staysInsideReal(run, { file_path: join(run, 'link', 'new.txt') })).toBe(false);
  });

  it('allows a normal file and a new file in the copy', async () => {
    expect(await staysInsideReal(run, { file_path: join(run, 'src', 'a.ts') })).toBe(true);
    expect(await staysInsideReal(run, { file_path: 'src/new/deeper/b.ts' })).toBe(true);
    expect(await staysInsideReal(run, { command: 'pnpm test' })).toBe(true);
  });

  it('checkStep refuses a Read through the link with the copy-only reason', async () => {
    const d = await checkStep(checkSettings({}), run, 'Read', { file_path: join(run, 'link', 'secret.txt') });
    expect(d).toEqual({ allow: false, reason: 'Only files in this feature’s own copy can be used.' });
    expect(await checkStep(checkSettings({}), run, 'Read', { file_path: join(run, 'src', 'a.ts') })).toEqual({ allow: true });
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
  type Seen = { task?: BuildTask; maxUsd?: number; answers: unknown[]; prompts?: string[]; caps?: number[]; previous?: unknown[]; watched?: string[]; liveStops?: number; homes?: string[]; removed?: string[] };
  /** opts.tests: what each test run gives (passes when it runs out); opts.fail: the model errors. */
  function deps(seen: Seen, withBuild = true, opts: { tests?: boolean[]; cases?: { name: string; passed: boolean }[]; fail?: string; noted?: string; tries?: [string, Record<string, unknown>][]; at?: Date; checks?: { name: string; passed: boolean; free: boolean; detail?: string; advisory?: boolean }[] } = {}): Deps {
    const results = [...(opts.tests ?? [])];
    const adapter: ModelAdapter = {
      provider: 'claude',
      run: async () => ({ text: '', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }),
      ...(withBuild
        ? {
            async build(task: BuildTask) {
              (seen.prompts ??= []).push(task.prompt);
              if (opts.fail) throw new Error(opts.fail);
              if (seen.task) {
                task.onStep?.('Edit src/fix.ts');
                return { text: 'Fixed the off-by-one.', usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.1 } };
              }
              seen.task = task;
              const tries: [string, Record<string, unknown>][] = [
                ['Write', { file_path: join(task.cwd, 'login.md'), content: 'Login' }],
                ['Bash', { command: 'git push origin main' }],
                ['Write', { file_path: join(code, 'hack.md'), content: 'x' }],
              ];
              if (opts.tries) tries.splice(0, tries.length, ...opts.tries);
              if (opts.noted) tries.push(['Bash', { command: opts.noted }]);
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
        seen.maxUsd ??= maxUsd;
        (seen.caps ??= []).push(maxUsd);
        return adapter;
      },
      async pickModel(_p, job) {
        return job === 'build' ? 'claude-sonnet-5-5' : 'claude-opus-5-5';
      },
      async modelName() {
        return 'Sonnet 5.5';
      },
      now: () => opts.at ?? NOW,
      // The build agent's throwaway home: recorded, not made, and its removal is recorded too.
      async sandboxHome(branch: string) {
        const home = join(root, 'sandbox-home', branch.replace(/[^A-Za-z0-9._-]+/g, '-'));
        (seen.homes ??= []).push(home);
        return { home, pnpmStore: join(root, 'pnpm-store') };
      },
      async removeSandboxHome(home: string) {
        (seen.removed ??= []).push(home);
      },
      // The live view (V2 A): shows the copy at once, and counts how often it's stopped.
      live(dir: string, onChange: (s: { url: string | null; note: string; reloads: boolean }) => void) {
        (seen.watched ??= []).push(dir);
        onChange({ url: 'http://127.0.0.1:5173/', note: 'Live: the build’s own copy, updating as it changes.', reloads: false });
        return {
          async stop() {
            seen.liveStops = (seen.liveStops ?? 0) + 1;
          },
        };
      },
      async pictures(_dir, out, previous) {
        (seen.previous ??= []).push(previous);
        const path = join(out, 'desktop.png');
        await mkdir(out, { recursive: true });
        await writeFile(path, 'png');
        return {
          pictures: [{ name: 'desktop' as const, path, hash: 'h1' }],
          checks: [
            { name: 'axe', passed: true, free: true, advisory: true, detail: 'No serious accessibility problems.' },
            { name: 'phone-overflow', passed: true, free: true, advisory: true, detail: 'Fits a phone’s width.' },
          ],
          changed: previous.length ? false : null,
          note: previous.length ? 'Pictures taken with Chrome; the screens look the same as the last build.' : 'Pictures taken with Chrome.',
        };
      },
      async freeChecks() {
        return opts.checks ?? [
          { name: 'secrets', passed: true, free: true, detail: 'No keys found in 1 changed file.' },
          { name: 'audit', passed: true, free: true, advisory: true, detail: 'No package.json, so there’s nothing to audit.' },
          { name: 'checklist', passed: false, free: true, advisory: true, detail: 'login.md:1 (Security): Use https:// links.' },
        ];
      },
      async runTests() {
        const passed = results.length ? results.shift()! : true;
        return { name: 'tests', passed, free: true, detail: passed ? '3 passed' : 'FAIL rota.test.ts: expected 2, got 3', ...(opts.cases ? { cases: opts.cases } : {}) };
      },
    };
  }

  async function plan(d: Deps, settings: Record<string, unknown>, live: Live = {}) {
    const call = async (method: string, params: Record<string, unknown>) => JSON.parse(await handleLine(JSON.stringify({ id: 1, method, params }), d, live));
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

  it('adds the feature’s known files from the project map to the prompt, at most 30', async () => {
    const seen: Seen = { answers: [] };
    const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    const call = await plan(deps(seen), settings);
    const files = Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`);
    await writeFile(join(data, 'projects', 'club-hr', 'map.json'), JSON.stringify({ version: 1, updatedAt: null, features: { 'F-01': { title: 'Login', files, tests: [], lastBuildId: 1, lastKeptAt: 'x' } } }));
    const r = await call('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath: join(root, 'history.sqlite') });
    expect(r.error).toBeUndefined();
    const prompt = seen.task!.prompt;
    expect(prompt).toContain('Files this feature touched in earlier builds');
    expect(prompt.split('\n').filter((l) => /^- src\/f\d+\.ts$/.test(l))).toHaveLength(30);
    expect(prompt).toContain('- …and 10 more');
  });

  it('tells the build the project’s decisions (the newest 10), not its blockers', async () => {
    const seen: Seen = { answers: [] };
    const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    const call = await plan(deps(seen), settings);
    const dbPath = join(root, 'history.sqlite');
    for (let i = 1; i <= 12; i++) await call('decision_add', { settings, slug: 'club-hr', text: `Rule number ${i}`, dbPath });
    await call('blocker_add', { settings, slug: 'club-hr', text: 'Waiting for the logo', feature: 'F-01', dbPath });
    const r = await call('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath });
    expect(r.error).toBeUndefined(); // an open blocker never stops the engine: joshua decides in the window
    const prompt = seen.task!.prompt;
    expect(prompt).toContain('Decisions the user made — follow them:');
    expect(prompt.split('\n').filter((l) => /^- DEC-\d+:/.test(l))).toHaveLength(10);
    expect(prompt).toContain('- DEC-12: Rule number 12');
    expect(prompt).not.toContain('Rule number 2\n');
    expect(prompt).not.toContain('Waiting for the logo');
  });

  it('asks for the done-list ids in test names, and marks each line from the test run', async () => {
    const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    const seen: Seen = { answers: [] };
    const call = await plan(deps(seen), settings);
    const dbPath = join(root, 'history.sqlite');
    const r = await call('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath });
    const prompt = seen.task!.prompt;
    expect(prompt).toContain('put the line’s id at the start of the test name');
    expect(prompt).toContain("it('D2:");
    expect(prompt).toContain('D1: A member can sign in');
    // No test names an id: the line is not checked, and that is advice only.
    const f = r.result.findings.find((x: { check: string }) => x.check === 'done-list');
    expect(f).toMatchObject({ level: 'warn', detail: 'D1 – not checked: A member can sign in' });
    expect(r.result.keep.keep).toBe(true);
    expect((await call('run_list', { dbPath, slug: 'club-hr' })).result[0].findings.at(-1).check).toBe('done-list');
  });

  it('marks a line tested when a passing test names its id', async () => {
    const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    const call = await plan(deps({ answers: [] }, true, { cases: [{ name: 'D1: a member can sign in', passed: true }] }), settings);
    const ok = await call('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath: join(root, 'history.sqlite') });
    expect(ok.result.findings.at(-1)).toMatchObject({ check: 'done-list', level: 'pass', detail: 'D1 ✓ tested: A member can sign in' });
  });

  it('a linked test with no assertion is not tested: the line is not checked, with the reason', async () => {
    const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    const d = deps({ answers: [] }, true, { cases: [{ name: 'D1: a member can sign in', passed: true }] });
    const real = d.runTests!;
    d.runTests = async (dir) => {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'login.test.ts'), "it('D1: a member can sign in', async () => {\n  await signIn();\n});\n");
      return real(dir);
    };
    const call = await plan(d, settings);
    const r = await call('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath: join(root, 'history.sqlite') });
    expect(r.result.findings.at(-1)).toMatchObject({ check: 'done-list', level: 'warn', detail: 'D1 – not checked: A member can sign in\n  ↳ test has no assertions' });
    // Advice only: Keep is still allowed.
    expect(r.result.keep.keep).toBe(true);
  });

  it('a linked failing test blocks Keep, as the failing tests already do', async () => {
    const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    const seen: Seen = { answers: [] };
    const call = await plan(deps(seen, true, { tests: [false, false, false, false], cases: [{ name: 'D1: a member can sign in', passed: false }] }), settings);
    const r = await call('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath: join(root, 'history.sqlite') });
    expect(r.result.findings.at(-1)).toMatchObject({ check: 'done-list', level: 'block' });
    // The same blockers as without coverage: just the tests.
    expect(r.result.keep).toEqual({ keep: false, blocking: ['tests'] });
  });

  it('builds one feature in its own copy, refusing what the gatekeeper or the copy rule stops', async () => {
    const seen: Seen = { answers: [] };
    const d = deps(seen);
    const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    const events: { type: string; text?: string; using?: string; url?: string | null; note?: string; advice?: string[] }[] = [];
    const call = await plan(d, settings, { emit: (e) => events.push(e as (typeof events)[number]) });
    await writeFile(join(data, 'rules.md'), '- Ask first.\n');
    const dbPath = join(root, 'history.sqlite');

    const r = await call('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath });
    expect(r.error).toBeUndefined();
    const out = r.result;
    expect(out.using).toBe('Using: Sonnet 5.5, file edits, shell, tests');
    expect(out.run).toMatchObject({ feature: 'F-01', branch: 'aip/f-01-20261111-170000' });
    expect(out.summary).toBe('Added the login page. Tests pass.');
    // V2 B: the summary's claims beside what the app found itself.
    expect(out.claims).toEqual([{ topic: 'Tests', agrees: true, note: 'The app checked this itself: passed.' }]);
    expect(out.costText).toBe('£0.33 ($0.42)');
    // It needs joshua now: a work item, not posted without a GitHub token (step 10b).
    expect(out.phone).toBe('Not sent to your phone: add a GitHub token in Settings for that.');
    expect((await call('work_list', { dbPath })).result).toMatchObject([{ runId: out.runId, title: 'club-hr F-01: built, waiting for Keep or Undo' }]);
    expect(seen.maxUsd).toBeCloseTo(0.8 / 0.79);

    // The model worked in the copy, was told the spec, and its bad steps were refused.
    expect(seen.task?.cwd).toBe(out.run.path);
    expect(seen.task?.prompt).toContain('Build feature F-01 (Login)');
    expect(seen.task?.prompt).toContain('=== done/F-01.md ===');
    // joshua's rules (and habits, learned ones included) go with every build (step 9d).
    expect(seen.task?.prompt).toContain('The user’s rules come first');
    expect(seen.task?.prompt).toContain('Rules:\n- Ask first.');
    expect(await readFile(join(out.run.path, 'login.md'), 'utf8')).toBe('Login');
    await expect(readFile(join(code, 'hack.md'), 'utf8')).rejects.toThrow();
    expect(seen.answers.map((a) => (a as { allow: boolean }).allow)).toEqual([true, false, false]);
    expect(out.steps.filter((s: { refused?: string }) => s.refused).map((s: { text: string }) => s.text)).toEqual(['Refused: Bash', 'Refused: Write']);

    // The screen saw the Using line first, then each step as it happened.
    expect(events[0]).toMatchObject({ type: 'using', using: 'Using: Sonnet 5.5, file edits, shell, tests' });
    // CI-4: what real builds say comes with it; this is the first build, so it's untested.
    expect(events[0].advice).toEqual(['No builds with Sonnet 5.5 yet, so this way of building is untested.']);
    expect(out.advice).toEqual(events[0].advice);
    expect(events.filter((e) => e.type === 'step').map((e) => e.text)).toEqual(out.steps.map((s: { text: string }) => s.text));

    // While the model worked, the screen could watch the copy live (V2 A). The live view closed
    // before the free checks and final pictures, which start the page themselves.
    expect(seen.watched).toEqual([out.run.path]);
    expect(events[1]).toMatchObject({ type: 'live', url: 'http://127.0.0.1:5173/' });
    const closed = events.findIndex((e) => e.type === 'live' && e.url === null);
    expect(events[closed]?.note).toBe('Live view closed: the build is done. The final pictures follow.');
    expect(events[closed + 1]).toMatchObject({ type: 'step', text: 'Running free checks' });
    expect(seen.liveStops).toBeGreaterThanOrEqual(1);
    expect(seen.task?.prompt).toContain('Don’t start another dev server');

    // Then the project's tests ran in the copy and passed first time; the data folder sync was tried.
    expect(out.steps.slice(-10).map((s: { text: string }) => s.text)).toEqual([
      'Running tests',
      'Tests pass',
      'Running free checks',
      'Secret scan: passed',
      'Package audit: passed',
      'Checklist rules: see notes',
      'Taking desktop and phone pictures',
      'Pictures taken with Chrome.',
      'Accessibility: passed',
      'Phone width: passed',
    ]);
    // The pictures sit next to the build's copy (never inside it, so Keep never merges them).
    expect(out.pictures).toEqual([{ name: 'desktop', path: join(`${out.run.path}-pictures`, 'desktop.png'), dataUrl: `data:image/png;base64,${Buffer.from('png').toString('base64')}` }]);
    expect(out.screensChanged).toBeNull();
    // Advice-only findings are reported but don't stop Keep.
    expect(out.keep).toEqual({ keep: true, blocking: [] });
    expect(out.findings.map((f: { check: string }) => f.check)).toEqual(['secrets', 'audit', 'checklist', 'axe', 'phone-overflow', 'done-list']);
    expect(out.tests).toEqual({ passed: true, output: '3 passed', fixAttempts: 0 });
    expect(out.synced).toMatch(/^Saved here, but not synced yet: .*not a git clone/);

    // The cost counts against the month's budget.
    expect((await call('spend_summary', { settings, dbPath })).result.calls).toBe(1);

    // The build is saved, waiting for Keep or Undo (step 9a).
    expect(out.runId).toBe(1);
    expect((await call('run_list', { dbPath, slug: 'club-hr' })).result).toMatchObject([
      { id: 1, feature: 'F-01', branch: out.run.branch, path: out.run.path, testsPassed: true, status: 'built', costUsd: 0.42 },
    ]);
    expect(typeof (await call('run_list', { dbPath, slug: 'club-hr' })).result[0].ms).toBe('number');
    expect((await call('run_list', { dbPath, slug: 'club-hr' })).result[0].findings[2]).toEqual({
      check: 'checklist',
      level: 'warn',
      title: 'Checklist rules: advice (doesn’t stop Keep)',
      detail: 'login.md:1 (Security): Use https:// links.',
      source: 'rule',
    });
    expect((await call('run_list', { dbPath, slug: 'club-hr' })).result[0].pictures).toEqual([{ name: 'desktop', path: out.pictures[0].path, hash: 'h1' }]);
  });

  it('an asked command waits in Needs you; Allow once lets it through one time in the next build, then it asks again', async () => {
    const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    const dbPath = join(root, 'history.sqlite');
    const push: [string, Record<string, unknown>] = ['Bash', { command: 'git push origin main' }];
    const first: Seen = { answers: [] };
    const call = await plan(deps(first), settings);
    const r1 = await call('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath });
    expect(r1.error).toBeUndefined();
    // The push was refused, with the new words, and is now waiting for joshua.
    expect(r1.result.steps.find((s: { refused?: string }) => s.refused?.startsWith('Gatekeeper (push)')).refused).toBe("Gatekeeper (push): pushing code needs joshua's OK. Not done. It's in Needs you for your OK.");
    const open = (await call('ask_list', { dbPath })).result;
    expect(open).toMatchObject([{ slug: 'club-hr', feature: 'F-01', branch: r1.result.run.branch, tool: 'Bash', input: 'git push origin main', reason: "Gatekeeper (push): pushing code needs joshua's OK" }]);

    const decided = await call('ask_decide', { dbPath, id: open[0].id, allow: true });
    expect(decided.result.note).toContain('Allowed once');
    expect((await call('ask_list', { dbPath })).result).toEqual([]);
    expect((await call('history_list', { dbPath })).result[0]).toMatchObject({ kind: 'approval', label: 'Allowed once: Bash in club-hr' });

    // The next build: the first try goes through, the second is refused (and asks again).
    const next: Seen = { answers: [] };
    const d2 = deps(next, true, { tries: [push, push], at: new Date('2026-11-11T18:00:00Z') });
    const call2 = async (method: string, params: Record<string, unknown>) => JSON.parse(await handleLine(JSON.stringify({ id: 1, method, params }), d2, {}));
    const r2 = await call2('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath });
    expect(r2.error).toBeUndefined();
    expect(next.answers.map((a) => (a as { allow: boolean }).allow)).toEqual([true, false]);
    expect((await call2('ask_list', { dbPath })).result).toHaveLength(1);

    // "No" closes a request and approves nothing.
    const [again2] = (await call2('ask_list', { dbPath })).result;
    expect((await call2('ask_decide', { dbPath, id: again2.id, allow: false })).result.note).toContain('Said No');
    expect((await call2('history_list', { dbPath })).result[0]).toMatchObject({ kind: 'approval', label: 'Said No: Bash in club-hr' });
    expect((await call2('ask_decide', { dbPath, id: again2.id, allow: false })).error).toContain('already answered');
  });

  it('adds a "Would ask" step for a command the new shell list would ask about, and still lets it run', async () => {
    const seen: Seen = { answers: [] };
    const call = await plan(deps(seen, true, { noted: 'docker ps' }), { dataFolder: data, codeFolders: { 'club-hr': code } });
    const r = await call('build_feature', { settings: { dataFolder: data, codeFolders: { 'club-hr': code } }, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath: join(root, 'history.sqlite') });
    expect(r.error).toBeUndefined();
    expect(seen.answers.map((a) => (a as { allow: boolean }).allow)).toEqual([true, false, false, true]);
    expect(seen.answers[3]).toMatchObject({ allow: true, note: expect.stringContaining('docker') });
    const texts = r.result.steps.map((s: { text: string }) => s.text);
    expect(texts).toContain("Would ask you under the new shell list: docker isn't on the list of known build commands; it needs joshua's OK");
    // Refusals are unchanged: only the two bad steps are refused, the noted one is not.
    expect(r.result.steps.filter((s: { refused?: string }) => s.refused).map((s: { text: string }) => s.text)).toEqual(['Refused: Bash', 'Refused: Write']);
  });

  it('gives the build agent a throwaway home folder and removes it afterwards', async () => {
    const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    const ok: Seen = { answers: [] };
    const call = await plan(deps(ok), settings);
    const r = await call('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath: null });
    expect(r.error).toBeUndefined();
    expect(ok.homes).toEqual([join(root, 'sandbox-home', 'aip-f-01-20261111-170000')]);
    expect(ok.task?.sandbox).toEqual({ home: ok.homes![0], pnpmStore: join(root, 'pnpm-store') });
    expect(ok.removed).toEqual(ok.homes);
  });

  it('removes the throwaway home folder even when the build fails', async () => {
    const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    const bad: Seen = { answers: [] };
    const call2 = await plan(deps(bad, true, { fail: 'boom' }), settings);
    const r2 = await call2('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath: null });
    expect(r2.error).toBeDefined();
    expect(bad.removed).toEqual(bad.homes);
    expect(bad.removed).toHaveLength(1);
  });

  it('records the versions in use, so an update marks old evidence stale until it works again (CI-1)', async () => {
    const seen: Seen = { answers: [] };
    const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    const call = await plan(deps(seen), settings);
    // axe-core's evidence is for an older version than the one installed now.
    await mkdir(join(data, 'tool-health'), { recursive: true });
    await writeFile(join(data, 'tool-health', 'axe-core.json'), JSON.stringify({ tool: 'axe-core', version: '4.0.0', testedVersion: '4.0.0' }));
    const out = (await call('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath: null })).result;
    const health = async (id: string) => JSON.parse(await readFile(join(data, 'tool-health', `${id}.json`), 'utf8'));
    const { checkToolVersions } = await import('@aip/checks');
    const axe = checkToolVersions()['axe-core'];

    // The build model's ID is its version; the first one seen is the baseline.
    expect(await health('sonnet-5-5')).toMatchObject({ id: 'sonnet-5-5', tool: 'Sonnet 5.5', version: 'claude-sonnet-5-5', testedVersion: 'claude-sonnet-5-5', stale: false });
    // axe-core updated and worked in this build, so its evidence is now for the new version.
    expect(await health('axe-core')).toMatchObject({ version: axe, testedVersion: axe, stale: false, retestDue: false });
    expect(out.steps.map((x: { text: string }) => x.text)).toContain(`axe-core updated to ${axe}: it worked in this build, so its evidence is up to date.`);
    expect(await health('secretlint')).toMatchObject({ tool: 'secretlint', consecutiveFailures: 0 });
    expect(await health('playwright')).toMatchObject({ tool: 'Playwright', consecutiveFailures: 0 });
  });

  it('does nothing when stopped before it starts', async () => {
    const seen = { answers: [] as unknown[] };
    const stop = new AbortController();
    stop.abort();
    const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    const call = await plan(deps(seen), settings, { signal: stop.signal });
    const r = await call('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath: null });
    expect(r.error).toBe('Stopped.');
    expect(git(code, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
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

  it('gives failing tests up to 2 fix attempts inside what’s left of the run’s limit', async () => {
    const seen: Seen = { answers: [] };
    const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    const call = await plan(deps(seen, true, { tests: [false, false, false] }), settings);
    const r = await call('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath: null });
    const out = r.result;
    expect(out.tests).toEqual({ passed: false, output: 'FAIL rota.test.ts: expected 2, got 3', fixAttempts: 2 });
    expect(out.steps.map((s: { text: string }) => s.text).filter((t: string) => !t.startsWith('Write') && !t.startsWith('Bash') && !t.startsWith('Refused'))).toEqual([
      'Running tests',
      'Fix attempt 1 of 2',
      'Edit src/fix.ts',
      'Running tests',
      'Fix attempt 2 of 2',
      'Edit src/fix.ts',
      'Running tests',
      'Tests still fail',
      'Running free checks',
      'Secret scan: passed',
      'Package audit: passed',
      'Checklist rules: see notes',
      'Taking desktop and phone pictures',
      'Pictures taken with Chrome.',
      'Accessibility: passed',
      'Phone width: passed',
    ]);
    expect(out.keep).toEqual({ keep: false, blocking: ['tests'] });
    // Each fix was told the test output, never to skip tests, and capped at what was left.
    expect(seen.prompts?.[1]).toContain('fix attempt 1 of 2');
    expect(seen.prompts?.[1]).toContain('Never skip, delete or weaken tests');
    expect(seen.prompts?.[1]).toContain('FAIL rota.test.ts');
    const cap = 0.8 / 0.79;
    expect(seen.caps?.[1]).toBeCloseTo(cap - 0.42);
    expect(seen.caps?.[2]).toBeCloseTo(cap - 0.52);
    expect(out.costUsd).toBeCloseTo(0.62);
    expect(out.summary).toContain('Fix 2: Fixed the off-by-one.');
  });

  it('stops fixing once the tests pass', async () => {
    const seen: Seen = { answers: [] };
    const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    const call = await plan(deps(seen, true, { tests: [false, true] }), settings);
    const out = (await call('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath: null })).result;
    expect(out.tests).toMatchObject({ passed: true, fixAttempts: 1 });
    expect(out.runId).toBeNull(); // no history file, nothing saved
    expect(out.steps.map((s: { text: string }) => s.text)).toContain('Tests pass');
  });

  it('switches the build model off after 3 failures in a row, and refuses it until switched back on', async () => {
    const seen: Seen = { answers: [] };
    const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    const d = deps(seen, true, { fail: 'Claude ended without an answer' });
    let tick = 0;
    d.now = () => new Date(NOW.getTime() + 1000 * tick++); // each run gets its own copy
    const call = await plan(d, settings);
    const build = () => call('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath: null });
    expect((await build()).error).toMatch(/^Claude ended without an answer \(Saved here/);
    expect((await build()).error).toMatch(/^Claude ended without an answer \(Saved here/);
    expect((await build()).error).toMatch(/^Claude ended without an answer Sonnet 5.5 has now failed 3 times in a row, so it’s switched off\. Switch it back on in Tools/);
    const health = JSON.parse(await readFile(join(data, 'tool-health', 'sonnet-5-5.json'), 'utf8'));
    expect(health.off.reason).toBe('3 failures in a row (last: Claude ended without an answer).');
    // A failed build still closes its live view, so nothing keeps running in the copy.
    expect(seen.liveStops).toBe(3);

    // Switched off: refused before any copy is made or money spent.
    const runs = git(code, 'worktree', 'list').trim().split('\n').length;
    expect((await build()).error).toBe('Sonnet 5.5 is switched off: 3 failures in a row (last: Claude ended without an answer). Switch it back on in Tools to use it again.');
    expect(git(code, 'worktree', 'list').trim().split('\n')).toHaveLength(runs);

    // The Tools screen lists it (it isn't in the ledger) with the flag for its button.
    await writeFile(join(data, 'ledger.md'), '# Ledger\n\n- Only CLI (oc) | ON | web reading | fewer tokens | free | rating: -\n');
    const overview = await call('data_overview', { settings });
    expect(overview.error).toBeUndefined();
    expect(overview.result.tools.find((t: { name: string }) => t.name === 'Sonnet 5.5')).toMatchObject({
      status: 'not in the ledger yet',
      switchedOff: true,
      health: 'Switched off: 3 failures in a row (last: Claude ended without an answer).',
    });

    // Switching it back on clears the count; the sync fails here (not a git clone) but the file is saved.
    const on = await call('tool_switch_on', { settings, tool: 'Sonnet 5.5' });
    expect(on.error).toMatch(/not a git clone/);
    const after = JSON.parse(await readFile(join(data, 'tool-health', 'sonnet-5-5.json'), 'utf8'));
    expect(after).toMatchObject({ off: null, consecutiveFailures: 0, retestDue: true });
    expect((await call('tool_switch_on', { settings, tool: 'Sonnet 5.5' })).error).toBe('Sonnet 5.5 isn’t switched off.');
  });

  it('a trusted build model that the 3-failure rule switches off drops to checked, not lower', async () => {
    const seen: Seen = { answers: [] };
    const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    await mkdir(join(data, 'tool-health'), { recursive: true });
    await writeFile(join(data, 'tool-health', 'sonnet-5-5.json'), JSON.stringify({ tool: 'Sonnet 5.5', id: 'sonnet-5-5', trust: 'trusted', lastOk: NOW.toISOString() }));
    const d = deps(seen, true, { fail: 'Claude ended without an answer' });
    let tick = 0;
    d.now = () => new Date(NOW.getTime() + 1000 * tick++);
    const call = await plan(d, settings);
    const build = () => call('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath: null });
    const trustNow = async () => JSON.parse(await readFile(join(data, 'tool-health', 'sonnet-5-5.json'), 'utf8')).trust;
    await build();
    await build();
    // Failures alone, even two in a row, don't lower trust: only the switch-off does.
    expect(await trustNow()).toBe('trusted');
    await build();
    expect(JSON.parse(await readFile(join(data, 'tool-health', 'sonnet-5-5.json'), 'utf8'))).toMatchObject({ off: { reason: expect.stringContaining('3 failures') }, trust: 'checked' });
  });

  it('doesn’t switch the model off for failures that aren’t its fault, and says so (Q-3)', async () => {
    const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    const opts: { fail: string } = { fail: '' };
    const d = deps({ answers: [] }, true, opts);
    let tick = 0;
    d.now = () => new Date(NOW.getTime() + 1000 * tick++);
    const call = await plan(d, settings);
    const build = () => call('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath: null });
    for (const [fail, words] of [
      ['Stopped: this run would have gone over its cost limit.', 'the run hit its cost limit'],
      ['Could not reach Claude. Check the internet connection.', 'the internet connection dropped'],
      ['529 overloaded_error', 'the provider was busy or down'],
    ] as const) {
      opts.fail = fail;
      for (let i = 0; i < 3; i++) {
        const err = (await build()).error as string;
        expect(err).toContain(`Not counted against Sonnet 5.5: ${words}.`);
        expect(err).not.toContain('switched off');
      }
      const health = JSON.parse(await readFile(join(data, 'tool-health', 'sonnet-5-5.json'), 'utf8'));
      expect(health).toMatchObject({ off: null, consecutiveFailures: 0 });
    }
    // Nothing was switched off, so a good run still goes ahead.
    opts.fail = '';
    expect((await build()).error).toBeUndefined();
  });

  it('once joshua has chosen tools for a project, only builds with an approved model, and adds the project’s rules (CI-7)', async () => {
    const seen: Seen = { answers: [] };
    const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    const d = deps(seen);
    const call = await plan(d, settings);
    const build = () => call('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath: null });
    await writeFile(join(data, 'projects', 'club-hr', 'tools.md'), '# Approved tools for club-hr\n\n- secretlint\n');
    await writeFile(join(data, 'projects', 'club-hr', 'rules.md'), '# Rules\n- Use British English\n');
    const runs = git(code, 'worktree', 'list').trim().split('\n').length;
    expect((await build()).error).toBe('Sonnet 5.5 isn’t approved for club-hr. Approve it in Projects → Tools for this project, or choose another model in Settings.');
    expect(git(code, 'worktree', 'list').trim().split('\n')).toHaveLength(runs);
    expect(seen.prompts).toBeUndefined();

    await writeFile(join(data, 'projects', 'club-hr', 'tools.md'), '- secretlint\n- sonnet-5-5\n');
    expect((await build()).error).toBeUndefined();
    expect(seen.prompts![0]).toContain('Rules for this project (these beat the general rules and habits):\n- Use British English');
  });

  it('doesn’t count a Stop as a failure', async () => {
    const seen: Seen = { answers: [] };
    const stop = new AbortController();
    const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
    const d = deps(seen, true, { fail: 'Stopped.' });
    const make = d.makeAdapter;
    d.makeAdapter = async (...a) => {
      const ad = await make(...a);
      return { ...ad, build: async (t) => { stop.abort(); return ad.build!(t); } };
    };
    const call = await plan(d, settings, { signal: stop.signal });
    expect((await call('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath: null })).error).toBe('Stopped.');
    await expect(readFile(join(data, 'tool-health', 'sonnet-5-5.json'), 'utf8')).rejects.toThrow();
  });
  describe('run records', () => {
    const rows = (dbPath: string) => {
      const log = RunLog.open(dbPath);
      try {
        return log.list();
      } finally {
        log.close();
      }
    };
    const spendRows = (dbPath: string) => {
      const db = new DatabaseSync(dbPath);
      try {
        return db.prepare('SELECT build_id, job FROM spend ORDER BY id').all() as { build_id: number | null; job: string }[];
      } finally {
        db.close();
      }
    };
    const setup = async (opts: Parameters<typeof deps>[2] = {}, live: Live = {}) => {
      const settings = { dataFolder: data, codeFolders: { 'club-hr': code } };
      const d = deps({ answers: [] }, true, opts);
      const call = await plan(d, settings, live);
      const dbPath = join(root, 'history.sqlite');
      const build = () => call('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath });
      return { d, build, dbPath };
    };

    it('adds the row when the build starts and fills in the same row when it finishes', async () => {
      const { d, build, dbPath } = await setup();
      let during: ReturnType<typeof rows> = [];
      const pictures = d.pictures!;
      d.pictures = async (...a) => {
        during = rows(dbPath);
        return pictures(...a);
      };
      const r = await build();
      expect(r.error).toBeUndefined();
      expect(during).toHaveLength(1);
      expect(during[0]).toMatchObject({ status: 'running', feature: 'F-01', costUsd: null, summary: '' });
      const after = rows(dbPath);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ id: during[0]!.id, status: 'built', cause: null, error: '', testsPassed: true, summary: 'Added the login page. Tests pass.' });
      expect(r.result.runId).toBe(during[0]!.id);
      // Every spend row of the build carries the build ID.
      expect(spendRows(dbPath)).toEqual([{ build_id: during[0]!.id, job: 'build' }]);
    });

    it('a model failure leaves a failed row with cause "model", the message and the cost so far', async () => {
      const { build, dbPath } = await setup({ fail: 'The model ended without an answer.' });
      const r = await build();
      expect(r.error).toContain('ended without an answer');
      const [row] = rows(dbPath);
      expect(rows(dbPath)).toHaveLength(1);
      expect(row).toMatchObject({ status: 'failed', cause: 'model', feature: 'F-01', costUsd: 0 });
      expect(row!.error).toContain('ended without an answer');
      expect(row!.endedAt).not.toBeNull();
      expect(row!.ms).not.toBeNull();
    });

    it('a cost-limit failure is cause "budget"', async () => {
      const { build, dbPath } = await setup({ fail: 'Stopped: this run would have gone over its cost limit.' });
      expect((await build()).error).toBeDefined();
      expect(rows(dbPath)[0]).toMatchObject({ status: 'failed', cause: 'budget' });
    });

    it('keeps the cost of earlier runs when a fix attempt fails, and links their spend rows', async () => {
      const { d, build, dbPath } = await setup({ tests: [false] });
      const make = d.makeAdapter;
      let calls = 0;
      d.makeAdapter = async (...a) => {
        const ad = await make(...a);
        return { ...ad, build: async (t) => (++calls > 1 ? Promise.reject(new Error('The model ended without an answer.')) : ad.build!(t)) };
      };
      expect((await build()).error).toBeDefined();
      const [row] = rows(dbPath);
      expect(row).toMatchObject({ status: 'failed', cause: 'model' });
      expect(row!.costUsd).toBeCloseTo(0.42);
      expect(spendRows(dbPath)).toEqual([{ build_id: row!.id, job: 'build' }]);
    });

    it('a Stop by joshua leaves a stopped row with no cause', async () => {
      const stop = new AbortController();
      const { d, build, dbPath } = await setup({ fail: 'Stopped.' }, { signal: stop.signal });
      const make = d.makeAdapter;
      d.makeAdapter = async (...a) => {
        const ad = await make(...a);
        return { ...ad, build: async (t) => { stop.abort(); return ad.build!(t); } };
      };
      expect((await build()).error).toBe('Stopped.');
      expect(rows(dbPath)[0]).toMatchObject({ status: 'stopped', cause: null, error: 'Stopped.' });
    });

    it('leaves no row when it fails before a copy was made', async () => {
      const { d, build, dbPath } = await setup();
      d.makeAdapter = async () => ({ provider: 'claude', run: async () => ({ text: '', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }) });
      expect((await build()).error).toContain('Building needs Claude');
      expect(rows(dbPath)).toEqual([]);
    });
  });
});

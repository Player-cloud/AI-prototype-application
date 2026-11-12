import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BuildTask, ModelAdapter } from '@aip/models';
import { checkStep, runCapUsd, staysInside } from '../src/build.ts';
import { checkSettings } from '../src/settings.ts';
import { handleLine, type Deps, type Live } from '../src/protocol.ts';

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
  type Seen = { task?: BuildTask; maxUsd?: number; answers: unknown[]; prompts?: string[]; caps?: number[]; previous?: unknown[]; watched?: string[]; liveStops?: number };
  /** opts.tests: what each test run gives (passes when it runs out); opts.fail: the model errors. */
  function deps(seen: Seen, withBuild = true, opts: { tests?: boolean[]; fail?: string; checks?: { name: string; passed: boolean; free: boolean; detail?: string; advisory?: boolean }[] } = {}): Deps {
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
      now: () => NOW,
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
        return { name: 'tests', passed, free: true, detail: passed ? '3 passed' : 'FAIL rota.test.ts: expected 2, got 3' };
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
    expect(seen.task?.prompt).toContain('joshua’s rules come first');
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
    expect(out.checks.map((c: { name: string }) => c.name)).toEqual(['secrets', 'audit', 'checklist', 'axe', 'phone-overflow']);
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
    expect((await call('run_list', { dbPath, slug: 'club-hr' })).result[0].checks[2]).toEqual({
      name: 'checklist',
      passed: false,
      advisory: true,
      detail: 'login.md:1 (Security): Use https:// links.',
    });
    expect((await call('run_list', { dbPath, slug: 'club-hr' })).result[0].pictures).toEqual([{ name: 'desktop', path: out.pictures[0].path, hash: 'h1' }]);
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
    const d = deps(seen, true, { fail: 'Claude is overloaded' });
    let tick = 0;
    d.now = () => new Date(NOW.getTime() + 1000 * tick++); // each run gets its own copy
    const call = await plan(d, settings);
    const build = () => call('build_feature', { settings, slug: 'club-hr', feature: 'F-01', provider: 'claude', apiKey: FAKE_KEY, dbPath: null });
    expect((await build()).error).toMatch(/^Claude is overloaded \(Saved here/);
    expect((await build()).error).toMatch(/^Claude is overloaded \(Saved here/);
    expect((await build()).error).toMatch(/^Claude is overloaded Sonnet 5.5 has now failed 3 times in a row, so it’s switched off\. Switch it back on in Tools/);
    const health = JSON.parse(await readFile(join(data, 'tool-health', 'sonnet-5-5.json'), 'utf8'));
    expect(health.off.reason).toBe('3 failures in a row (last: Claude is overloaded).');
    // A failed build still closes its live view, so nothing keeps running in the copy.
    expect(seen.liveStops).toBe(3);

    // Switched off: refused before any copy is made or money spent.
    const runs = git(code, 'worktree', 'list').trim().split('\n').length;
    expect((await build()).error).toBe('Sonnet 5.5 is switched off: 3 failures in a row (last: Claude is overloaded). Switch it back on in Tools to use it again.');
    expect(git(code, 'worktree', 'list').trim().split('\n')).toHaveLength(runs);

    // The Tools screen lists it (it isn't in the ledger) with the flag for its button.
    await writeFile(join(data, 'ledger.md'), '# Ledger\n\n- Only CLI (oc) | ON | web reading | fewer tokens | free | rating: -\n');
    const overview = await call('data_overview', { settings });
    expect(overview.error).toBeUndefined();
    expect(overview.result.tools.find((t: { name: string }) => t.name === 'Sonnet 5.5')).toMatchObject({
      status: 'not in the ledger yet',
      switchedOff: true,
      health: 'Switched off: 3 failures in a row (last: Claude is overloaded).',
    });

    // Switching it back on clears the count; the sync fails here (not a git clone) but the file is saved.
    const on = await call('tool_switch_on', { settings, tool: 'Sonnet 5.5' });
    expect(on.error).toMatch(/not a git clone/);
    const after = JSON.parse(await readFile(join(data, 'tool-health', 'sonnet-5-5.json'), 'utf8'));
    expect(after).toMatchObject({ off: null, consecutiveFailures: 0, retestDue: true });
    expect((await call('tool_switch_on', { settings, tool: 'Sonnet 5.5' })).error).toBe('Sonnet 5.5 isn’t switched off.');
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
});

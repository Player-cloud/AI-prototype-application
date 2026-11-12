/**
 * Step 8b: one feature build. The engine makes the feature's own copy of the code (8a), shows the
 * Using line, then lets the build model (Sonnet for Claude) work in that copy. Every tool call is
 * checked first: it must stay inside the copy, and it goes through the gatekeeper. A run stops at
 * its cost limit (joshua chose £0.80 by default) or what's left of the month's budget.
 *
 * Step 8d: after the build the project's own tests run in the copy. If they fail, the model gets
 * up to 2 fix attempts inside what's left of the run's limit. Each model run goes in the model's
 * health record; 3 failures in a row switch it off until joshua switches it back on (D-2). The
 * data folder syncs after the task.
 */
import { notApproved, projectGuidance } from './project-tools.ts';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { CheckResult, LiveState, Picture, PicturesResult } from '@aip/checks';
import type { FailureCause } from '@aip/memory';
import { failureCause } from '@aip/models';
import type { ModelAdapter, Provider, ToolDecision } from '@aip/models';
import { readBudget, recordSpend } from './budget.ts';
import { compareClaims, type Claim } from './claims.ts';
import { gate } from './gate.ts';
import { guidance } from './learn.ts';
import { usingLine } from './using.ts';
import { adviceFor } from './workflows.ts';
import { QUESTIONS_PROMPT, answersFor, questionsIn, shortenKeepingQuestions } from './questions.ts';
import type { Interview } from './interview.ts';
import { getInterview } from './projects.ts';
import { specText } from './review.ts';
import { startRun, type StartedRun } from './runs.ts';
import type { AppSettings } from './settings.ts';

export interface BuildDeps {
  makeAdapter(provider: Provider, apiKey: string, settings: AppSettings, maxUsd: number): Promise<ModelAdapter>;
  pickModel(provider: Provider, job: 'build', settings: AppSettings): Promise<string>;
  modelName(id: string): Promise<string>;
  now?(): Date;
  /** Runs the project's tests in the copy (8d). Injected for tests; the real one is @aip/checks. */
  runTests?(dir: string): Promise<CheckResult>;
  /** The free checks after the tests (9b): secrets, audit, checklist rules. */
  freeChecks?(dir: string, base: string, areas: string[]): Promise<CheckResult[]>;
  /** Desktop and phone pictures plus axe and phone width (9c), with the browser already on the computer. */
  pictures?(dir: string, outDir: string, previous: Picture[]): Promise<PicturesResult>;
  /** The live view while the model works (V2 A); null turns it off. The real one is @aip/checks. */
  live?: ((dir: string, onChange: (s: LiveState) => void) => { stop(): Promise<void> }) | null;
  /** Makes the build agent's throwaway home folder (and finds the pnpm store). Injected for tests. */
  sandboxHome?(runBranch: string): Promise<{ home: string; pnpmStore?: string }>;
  /** Removes that folder at the end. Injected for tests; the real one never throws. */
  removeSandboxHome?(home: string): Promise<void>;
}

/** The pnpm store, asked once with the real environment. Left out if pnpm isn't there or is slow. */
function findPnpmStore(): Promise<string | undefined> {
  return new Promise((done) => {
    try {
      execFile('pnpm', ['store', 'path'], { timeout: 15_000, shell: process.platform === 'win32', windowsHide: true }, (err, out) => {
        const path = String(out ?? '').trim();
        done(err || !path || path.includes('\n') ? undefined : path);
      });
    } catch {
      done(undefined);
    }
  });
}

/** A fresh empty home folder for one build run: no git login, no keys, just the folders tools expect. */
export async function makeSandboxHome(runBranch: string): Promise<{ home: string; pnpmStore?: string }> {
  const name = runBranch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '') || 'run';
  const home = join(tmpdir(), 'ai-prototype-build-home', name);
  await rm(home, { recursive: true, force: true });
  await mkdir(join(home, 'AppData', 'Roaming'), { recursive: true });
  await mkdir(join(home, 'AppData', 'Local'), { recursive: true });
  await writeFile(join(home, '.gitconfig'), '');
  const pnpmStore = await findPnpmStore();
  return { home, ...(pnpmStore ? { pnpmStore } : {}) };
}

async function removeHome(home: string): Promise<void> {
  try {
    await rm(home, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover temp folder is harmless.
  }
}

export interface BuildStep { text: string; refused?: string }

/** What a running build reports as it goes. */
export type BuildEvent =
  | { type: 'using'; using: string; run: StartedRun; advice: string[] }
  | ({ type: 'step' } & BuildStep)
  | ({ type: 'live' } & LiveState);

export interface BuildResult {
  run: StartedRun;
  using: string;
  /** CI-4: what real builds say about this way of building. Advice only: it never changes the pick. */
  advice: string[];
  steps: BuildStep[];
  /** What the model said it did. Not checked by the app: see `claims`. */
  summary: string;
  /** What the summary claims, beside what the app's own tests and checks found (V2 B). */
  claims: Claim[];
  /** D: what the model had to guess, for joshua to answer (it carried on with the safest choice). */
  questions: string[];
  model: string;
  /** What every model run in this build cost together. */
  costUsd: number | null;
  /** The project's tests after the build (and any fix attempts). Tests are never skipped. */
  tests: { passed: boolean; output: string; fixAttempts: number };
  /** How the data folder sync went ('' with no data folder). */
  synced: string;
  /** The saved run that Keep, Undo and the rating act on (null without a history file). */
  runId: number | null;
  /** The free checks (9b). Advice-only ones don't stop Keep. */
  checks: CheckResult[];
  /** Whether Keep is allowed, and what stops it. */
  keep: { keep: boolean; blocking: string[] };
  /** Desktop and phone pictures (9c), ready to show. */
  pictures: { name: string; path: string; dataUrl: string }[];
  /** Against the last build's pictures; null when there was nothing to compare with. */
  screensChanged: boolean | null;
  picturesNote: string;
}

/** The run's limit in dollars: the Settings limit (in £) or what's left this month, whichever is less. */
export function runCapUsd(settings: AppSettings, leftUsd: number | null): number {
  const cap = settings.runCapGbp / settings.gbpPerUsd;
  return leftUsd === null ? cap : Math.min(cap, leftUsd);
}

export function buildPrompt(iv: Interview, feature: string, spec: string): string {
  const f = iv.features.find((x) => x.id === feature);
  return [
    `Build feature ${feature}${f ? ` (${f.name})` : ''} of the web app "${iv.name}", and only that feature.`,
    'You are working in a separate copy of the project’s repo; it is your current folder. Change files only here.',
    `Build it so every check in done/${feature}.md passes. Add or update tests for it, and run them.`,
    'Keep changes small. Don’t push, deploy, install things globally or call outside services: those need joshua’s OK and will be refused.',
    'Never read or write key files (.env, *.pem).',
    'The app already runs this copy’s page (next dev, vite or index.html) so joshua can watch it change. Don’t start another dev server: two in one folder clash.',
    'When you’re done, reply with a short plain-words summary of what you changed and what the tests showed.',
    QUESTIONS_PROMPT,
    '',
    spec,
  ].join('\n');
}

const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const;

const inside = (runPath: string, p: string) => {
  // A Windows drive or network path can't be inside the copy on Linux.
  if (process.platform !== 'win32' && /^([A-Za-z]:[\\/]|\\\\)/.test(p)) return false;
  const rel = relative(resolve(runPath), resolve(runPath, p));
  return !(rel.startsWith('..') || isAbsolute(rel));
};

/** Path-like words in a shell command: absolute paths, ~, and anything climbing out with "..". */
function commandPaths(command: string): string[] {
  return command
    .split(/[\s;|&<>()'"`=]+/)
    .filter((w) => /^(\/|~|[A-Za-z]:[\\/]|\\\\)/.test(w) || /(^|[\\/])\.\.([\\/]|$)/.test(w));
}

/**
 * True when every path the tool names is inside the run's copy. For shell commands this is a
 * best-effort check of the paths written in the command (absolute paths, ~ and ".." are refused
 * unless they point inside the copy).
 */
export function staysInside(runPath: string, input: Record<string, unknown>): boolean {
  for (const k of PATH_KEYS) {
    const v = input[k];
    if (typeof v === 'string' && v !== '' && !inside(runPath, v)) return false;
  }
  if (typeof input.command === 'string') {
    for (const w of commandPaths(input.command)) if (w.startsWith('~') || !inside(runPath, w)) return false;
  }
  return true;
}

/** The real place of a path, links followed. A file that isn't there yet gets its nearest existing folder. */
async function realNearest(p: string): Promise<string> {
  let cur = resolve(p);
  for (;;) {
    try {
      return await realpath(cur);
    } catch {
      const up = dirname(cur);
      if (up === cur) return cur;
      cur = up;
    }
  }
}

/** Windows file names ignore capital letters. */
const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/**
 * Like `staysInside`, but follows links. A link inside the copy that points outside (say
 * `home -> your home folder`) passes the plain word check, so each file path is turned into its
 * real place first and that must still be inside the copy's real place. Shell commands can't be
 * checked this way; they only get the word check.
 */
export async function staysInsideReal(runPath: string, input: Record<string, unknown>): Promise<boolean> {
  let root: string | undefined;
  for (const k of PATH_KEYS) {
    const v = input[k];
    if (typeof v !== 'string' || v === '') continue;
    root ??= await realNearest(runPath);
    const real = await realNearest(resolve(runPath, v));
    const rel = relative(norm(root), norm(real));
    if (rel.startsWith('..') || isAbsolute(rel)) return false;
  }
  return true;
}

/** Where a build's asks are kept, so an ask-first refusal can become a request in Needs you. */
export interface AskStore {
  slug: string;
  feature: string;
  /** The build's run branch. */
  branch: string;
  dbPath: string;
  now?: Date;
  /** Called when an "Allow once" was used up. */
  onAllowed?: () => void;
}

/**
 * The check before every tool call: inside the copy (words, then real places), then the gatekeeper.
 * An ask-first answer is refused and becomes a request in Needs you, unless joshua already said
 * "Allow once" for that exact thing in this project (that is used up here). Never-rules, the
 * guard on the rules and the own-copy checks are decided before and can't be overridden.
 */
export async function checkStep(settings: AppSettings, runPath: string, tool: string, input: Record<string, unknown>, asks?: AskStore): Promise<ToolDecision> {
  if (!staysInside(runPath, input) || !(await staysInsideReal(runPath, input))) return { allow: false, reason: 'Only files in this feature’s own copy can be used.' };
  const d = gate(tool, input, settings);
  if (d.allow) return d;
  if (d.askJoshua !== true) return { allow: false, reason: d.reason };
  if (!asks) return { allow: false, reason: `${d.reason}. Not done.` };
  try {
    const { recordAsk, useApproval } = await import('./asks.ts');
    if (await useApproval(asks, tool, input)) {
      asks.onAllowed?.();
      return { allow: true };
    }
    await recordAsk(asks, tool, input, d.reason);
  } catch {
    // A problem with the history file never stops a build; the step is just refused.
    return { allow: false, reason: `${d.reason}. Not done.` };
  }
  return { allow: false, reason: `${d.reason}. Not done. It's in Needs you for your OK.` };
}

/** Plain names for the step list. */
const CHECK_NAMES: Record<string, string> = { secrets: 'Secret scan', audit: 'Package audit', dependencies: 'New packages', checklist: 'Checklist rules', axe: 'Accessibility', 'phone-overflow': 'Phone width' };

/** How many times a failing test run is handed back to the model to fix (inside the run's limit). */
export const FIX_ATTEMPTS = 2;
/** Failures in a row before a tool is switched off (D-2). */
export const OFF_AFTER = 3;
/** Less than this left in a run's limit isn't worth a fix attempt. */
const MIN_FIX_USD = 0.02;

export function fixPrompt(feature: string, attempt: number, testOutput: string): string {
  return [
    `The tests fail after building feature ${feature}. This is fix attempt ${attempt} of ${FIX_ATTEMPTS}.`,
    'Find the cause and fix the code so the tests pass. Never skip, delete or weaken tests to make them pass.',
    'Stay in this folder. When done, reply with a short plain-words summary of what you fixed.',
    '',
    'End of the test output:',
    testOutput,
  ].join('\n');
}

const stopped = (signal?: AbortSignal) => signal?.aborted === true;

/** Commits and syncs the data folder after a task. A failed sync keeps everything saved here. */
async function syncAfter(settings: AppSettings, message: string): Promise<string> {
  if (!settings.dataFolder) return '';
  try {
    const m = await import('@aip/memory');
    return (await m.syncDataRepo(settings.dataFolder, message)).summary;
  } catch (err) {
    return `Saved here, but not synced yet: ${(err as Error).message}`;
  }
}

export async function buildFeature(
  settings: AppSettings,
  p: { slug: string; feature: string; provider: Provider; apiKey: string; dbPath: string | null },
  deps: BuildDeps,
  onEvent?: (e: BuildEvent) => void,
  signal?: AbortSignal,
): Promise<BuildResult> {
  if (stopped(signal)) throw new Error('Stopped.');
  const now = deps.now?.() ?? new Date();
  let leftUsd: number | null = null;
  let rulesFirst = true;
  if (p.dbPath) {
    const b = await readBudget(p.dbPath, settings, now);
    if (b.leftUsd <= 0) throw new Error(`This month’s budget is used up (£${b.spentGbp} of £${b.budgetGbp}). Raise it in Settings, or wait until next month.`);
    leftUsd = b.leftUsd;
    rulesFirst = b.rulesWin;
  }
  const cap = runCapUsd(settings, leftUsd);
  const model = await deps.pickModel(p.provider, 'build', settings);
  const tool = await deps.modelName(model);
  const toolId = await toolIdOf(settings, tool);
  const runInfo = { tool, id: toolId, version: model };
  if (settings.dataFolder) {
    const m = await import('@aip/memory');
    const h = await m.readHealth(settings.dataFolder, tool, toolId);
    if (h.off) throw new Error(`${tool} is switched off: ${h.off.reason} Switch it back on in Tools to use it again.`);
  }
  const refused = await notApproved(settings, p.slug, toolId, tool);
  if (refused) throw new Error(refused);
  const adapter = await deps.makeAdapter(p.provider, p.apiKey, settings, cap);
  if (!adapter.build) throw new Error('Building needs Claude for now. Choose Claude in Settings → Budget and models.');
  const { interview } = await getInterview(settings, p.slug);
  const run = await startRun(settings, p.slug, p.feature, now);
  const using = usingLine(model, ['file edits', 'shell', 'tests']);
  let advice: string[] = [];
  try {
    advice = await adviceFor(p.dbPath ?? undefined, model, (id) => deps.modelName(id), settings.gbpPerUsd);
  } catch {
    // The evidence is advice; a build never stops for it.
  }
  onEvent?.({ type: 'using', using, run, advice });
  const watch = deps.live === undefined ? (await import('@aip/checks')).watchLive : deps.live;
  const live = watch ? watch(run.path, (s) => onEvent?.({ type: 'live', ...s })) : null;
  let sandbox: { home: string; pnpmStore?: string } | undefined;
  try {
    sandbox = await (deps.sandboxHome ?? makeSandboxHome)(run.branch);
    return await afterStart();
  } finally {
    await live?.stop();
    if (sandbox) {
      try {
        await (deps.removeSandboxHome ?? removeHome)(sandbox.home);
      } catch {
        // Never throws.
      }
    }
  }

  async function afterStart(): Promise<BuildResult> {
    const steps: BuildStep[] = [];
    const add = (s: BuildStep) => {
      steps.push(s);
      onEvent?.({ type: 'step', ...s });
    };
    const task = (prompt: string, a: ModelAdapter) =>
      a.build!({
        model,
        prompt,
        cwd: run.path,
        signal,
        sandbox,
        onStep: (text) => add({ text }),
        async checkTool(name, input) {
          const d = await checkStep(settings, run.path, name, input, p.dbPath ? { slug: p.slug, feature: p.feature, branch: run.branch, dbPath: p.dbPath, onAllowed: () => add({ text: `Allowed once by joshua: ${name}` }) } : undefined);
          if (!d.allow) add({ text: `Refused: ${name}`, refused: d.reason });
          // The shell allow-list is on trial: allowed, but joshua can see what enforcing it would change.
          else if (d.note) add({ text: `Would ask joshua under the new shell list: ${d.note}` });
          return d;
        },
      });

    let spentUsd = 0;
    /** One model run: its spend counts, and its success or failure goes in the tool's health record. */
    const once = async (prompt: string, a: ModelAdapter) => {
      try {
        const out = await task(prompt, a);
        spentUsd += out.usage.costUsd ?? 0;
        if (p.dbPath) await recordSpend(p.dbPath, { at: now, provider: p.provider, model, job: 'build', ...out.usage });
        await noteRun(settings, runInfo, { ok: true }, now);
        return out.text.trim();
      } catch (err) {
        if (stopped(signal)) throw new Error('Stopped.');
        // Q-3: only the model's own fault counts towards switching it off.
        const cause: FailureCause = failureCause((err as Error).message);
        const off = await noteRun(settings, runInfo, { ok: false, error: (err as Error).message, cause }, now);
        const notCounted = cause === 'model' ? '' : ` Not counted against ${tool}: ${(await import('@aip/memory')).causeWords(cause)}.`;
        const sync = await syncAfter(settings, `Build ${p.slug} ${p.feature}: ${tool} failed`);
        const more = off ? ` ${tool} has now failed ${OFF_AFTER} times in a row, so it’s switched off. Switch it back on in Tools when you’re ready.` : '';
        throw new Error(`${(err as Error).message}${notCounted}${more}${sync ? ` (${sync})` : ''}`);
      }
    };

    const prompt =
      buildPrompt(interview, p.feature, specText(interview, new Date(interview.specAt ?? now))) + (await answersFor(settings, p.slug)) + (await projectGuidance(settings, p.slug)) + (await guidance(settings, rulesFirst));
    let summary = await once(prompt, adapter);

    const runTests = deps.runTests ?? (await import('@aip/checks')).runTests;
    add({ text: 'Running tests' });
    let tests = await runTests(run.path);
    let fixes = 0;
    while (!tests.passed && fixes < FIX_ATTEMPTS && !stopped(signal)) {
      const left = cap - spentUsd;
      if (left < MIN_FIX_USD) {
        add({ text: 'No money left in this run’s limit for a fix.' });
        break;
      }
      fixes += 1;
      add({ text: `Fix attempt ${fixes} of ${FIX_ATTEMPTS}` });
      const fixer = await deps.makeAdapter(p.provider, p.apiKey, settings, left);
      const fixed = await once(fixPrompt(p.feature, fixes, tests.detail ?? ''), fixer);
      if (fixed) summary = `${summary}\n\nFix ${fixes}: ${fixed}`;
      add({ text: 'Running tests' });
      tests = await runTests(run.path);
    }
    if (stopped(signal)) throw new Error('Stopped.');
    add({ text: tests.passed ? 'Tests pass' : 'Tests still fail' });
    if (live) {
      await live.stop(); // the final pictures start the page themselves
      onEvent?.({ type: 'live', url: null, note: 'Live view closed: the build is done. The final pictures follow.', reloads: false });
    }
    add({ text: 'Running free checks' });
    const freeChecks = deps.freeChecks ?? (await import('@aip/checks')).runFreeChecks;
    let checks: CheckResult[];
    try {
      checks = await freeChecks(run.path, run.base, interview.areas);
    } catch (err) {
      checks = [{ name: 'free checks', passed: false, free: true, detail: `Couldn’t run: ${(err as Error).message}` }];
    }
    for (const c of checks) add({ text: `${CHECK_NAMES[c.name] ?? c.name}: ${c.passed ? 'passed' : c.advisory ? 'see notes' : 'failed'}` });

    add({ text: 'Taking desktop and phone pictures' });
    let previous: Picture[] = [];
    if (p.dbPath) {
      const m = await import('@aip/memory');
      const log = m.RunLog.open(p.dbPath);
      try {
        previous = log.lastPictures(p.slug).map((x) => ({ ...x, name: x.name === 'phone' ? 'phone' : 'desktop' }));
      } finally {
        log.close();
      }
    }
    const takePictures = deps.pictures ?? (async (dir: string, out: string, prev: Picture[]) => (await import('@aip/checks')).takePictures(dir, out, { previous: prev }));
    let shots: PicturesResult;
    try {
      shots = await takePictures(run.path, `${run.path}-pictures`, previous);
    } catch (err) {
      const note = `No pictures: ${(err as Error).message.split('\n')[0]}`;
      shots = { pictures: [], checks: [{ name: 'pictures', passed: false, free: true, advisory: true, detail: note }], changed: null, note };
    }
    add({ text: shots.note.split('\n')[0]! });
    for (const c of shots.checks) if (c.name !== 'pictures') add({ text: `${CHECK_NAMES[c.name] ?? c.name}: ${c.passed ? 'passed' : 'see notes'}` });
    checks.push(...shots.checks);
    for (const line of await noteCheckTools(settings, checks, shots.pictures.length > 0, now)) add({ text: line });
    const { canKeep } = await import('@aip/checks');
    const keep = canKeep([{ ...tests, name: 'tests' }, ...checks]);
    const synced = await syncAfter(settings, `Build ${p.slug} ${p.feature}`);
    let runId: number | null = null;
    if (p.dbPath) {
      const m = await import('@aip/memory');
      const log = m.RunLog.open(p.dbPath);
      try {
        runId = log.add({
          at: now,
          slug: p.slug,
          feature: p.feature,
          path: run.path,
          branch: run.branch,
          base: run.base,
          model,
          costUsd: spentUsd,
          testsPassed: tests.passed,
          fixAttempts: fixes,
          summary: shortenKeepingQuestions(summary, 2000),
          checks: checks.map((c) => ({ name: c.name, passed: c.passed, advisory: c.advisory ?? false, detail: c.detail ?? '' })),
          pictures: shots.pictures,
          ms: Math.max(0, (deps.now?.() ?? new Date()).getTime() - now.getTime()),
        });
      } finally {
        log.close();
      }
    }
    return {
      runId,
      run,
      using,
      advice,
      steps,
      summary: shortenKeepingQuestions(summary, 2000),
      claims: compareClaims(summary, [{ ...tests, name: 'tests' }, ...checks]),
      questions: questionsIn(summary),
      model,
      costUsd: spentUsd,
      tests: { passed: tests.passed, output: tests.detail ?? '', fixAttempts: fixes },
      synced,
      checks,
      keep,
      pictures: await Promise.all(
        shots.pictures.map(async (x) => ({ name: x.name, path: x.path, dataUrl: `data:image/png;base64,${(await readFile(x.path)).toString('base64')}` })),
      ),
      screensChanged: shots.changed,
      picturesNote: shots.note,
    };
  }
}

/**
 * Records one model run in its health record (only when a data folder is set). Returns true when
 * this failure switched the tool off: OFF_AFTER failures in a row (D-2). Off never uninstalls.
 */
async function noteRun(settings: AppSettings, t: { tool: string; id: string; version: string }, run: { ok: true } | { ok: false; error?: string; cause: FailureCause }, now: Date): Promise<boolean> {
  if (!settings.dataFolder) return false;
  const m = await import('@aip/memory');
  // CI-1: the model ID is its version. A new one marks old evidence stale; a good run clears it.
  const computer = (await import('@aip/checks')).computerId();
  let h = m.recordRun(m.noteVersion(await m.readHealth(settings.dataFolder, t.tool, t.id), t.version, computer), run, now, computer);
  const off = !run.ok && m.countsAgainst(run.cause) && !h.off && h.consecutiveFailures >= OFF_AFTER;
  if (off) h = m.switchOff(h, `${OFF_AFTER} failures in a row (last: ${h.failures.at(-1)?.error ?? 'unknown'}).`, now);
  await m.writeHealth(settings.dataFolder, h);
  return off;
}

/** The stable ID for a tool name, from the data repo's ledger and cards (CI-1). */
async function toolIdOf(settings: AppSettings, name: string): Promise<string> {
  const m = await import('@aip/memory');
  if (!settings.dataFolder) return m.slugify(name);
  try {
    return m.toolIdFor((await m.loadDataRepo(settings.dataFolder)).tools, name);
  } catch {
    return m.slugify(name);
  }
}

/**
 * CI-1: notes each free-check tool's version and whether it worked in this build. A new version
 * marks its old evidence stale; a good run in the same build clears that again (D-2). Check tools
 * are never switched off here. Returns plain-words lines for the step list (only for updates).
 * A problem here never stops the build.
 */
async function noteCheckTools(settings: AppSettings, checks: CheckResult[], picturesTaken: boolean, now: Date): Promise<string[]> {
  if (!settings.dataFolder) return [];
  const lines: string[] = [];
  try {
    const c = await import('@aip/checks');
    const m = await import('@aip/memory');
    const computer = c.computerId(); // CI-2: each computer's versions are its own
    for (const use of c.checkToolUses(checks, picturesTaken, c.checkToolVersions())) {
      const before = await m.readHealth(settings.dataFolder, use.name, use.id);
      const seen = use.version ? m.noteVersion(before, use.version, computer) : before;
      const after = m.recordRun(seen, use.ok ? { ok: true } : { ok: false, error: use.error, cause: 'tool' }, now, computer);
      await m.writeHealth(settings.dataFolder, after);
      if (seen.stale && !before.stale) lines.push(`${use.name} updated to ${use.version}: ${after.stale ? 'it didn’t work this time, so it’s marked for a retest.' : 'it worked in this build, so its evidence is up to date.'}`);
    }
  } catch {
    // tool records are best effort
  }
  return lines;
}

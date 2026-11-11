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
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { CheckResult, Picture, PicturesResult } from '@aip/checks';
import type { ModelAdapter, Provider, ToolDecision } from '@aip/models';
import { readBudget, recordSpend } from './budget.ts';
import { gate } from './gate.ts';
import { guidance } from './learn.ts';
import { usingLine } from './using.ts';
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
}

export interface BuildStep { text: string; refused?: string }

/** What a running build reports as it goes. */
export type BuildEvent = { type: 'using'; using: string; run: StartedRun } | ({ type: 'step' } & BuildStep);

export interface BuildResult {
  run: StartedRun;
  using: string;
  steps: BuildStep[];
  /** What the model said it did. */
  summary: string;
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
    'When you’re done, reply with a short plain-words summary of what you changed and what the tests showed.',
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

/** The check before every tool call: inside the copy, then the gatekeeper. */
export function checkStep(settings: AppSettings, runPath: string, tool: string, input: Record<string, unknown>): ToolDecision {
  if (!staysInside(runPath, input)) return { allow: false, reason: 'Only files in this feature’s own copy can be used.' };
  const d = gate(tool, input, settings);
  if (d.allow) return d;
  return { allow: false, reason: d.askJoshua ? `${d.reason}. Not done; joshua will be asked later.` : d.reason };
}

/** Plain names for the step list. */
const CHECK_NAMES: Record<string, string> = { secrets: 'Secret scan', audit: 'Package audit', checklist: 'Checklist rules', axe: 'Accessibility', 'phone-overflow': 'Phone width' };

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
  if (settings.dataFolder) {
    const m = await import('@aip/memory');
    const h = await m.readHealth(settings.dataFolder, tool);
    if (h.off) throw new Error(`${tool} is switched off: ${h.off.reason} Switch it back on in Tools to use it again.`);
  }
  const adapter = await deps.makeAdapter(p.provider, p.apiKey, settings, cap);
  if (!adapter.build) throw new Error('Building needs Claude for now. Choose Claude in Settings → Budget and models.');
  const { interview } = await getInterview(settings, p.slug);
  const run = await startRun(settings, p.slug, p.feature, now);
  const using = usingLine(model, ['file edits', 'shell', 'tests']);
  onEvent?.({ type: 'using', using, run });
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
      onStep: (text) => add({ text }),
      async checkTool(name, input) {
        const d = checkStep(settings, run.path, name, input);
        if (!d.allow) add({ text: `Refused: ${name}`, refused: d.reason });
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
      await noteRun(settings, tool, { ok: true }, now);
      return out.text.trim();
    } catch (err) {
      if (stopped(signal)) throw new Error('Stopped.');
      const off = await noteRun(settings, tool, { ok: false, error: (err as Error).message }, now);
      const sync = await syncAfter(settings, `Build ${p.slug} ${p.feature}: ${tool} failed`);
      const more = off ? ` ${tool} has now failed ${OFF_AFTER} times in a row, so it’s switched off. Switch it back on in Tools when you’re ready.` : '';
      throw new Error(`${(err as Error).message}${more}${sync ? ` (${sync})` : ''}`);
    }
  };

  const prompt = buildPrompt(interview, p.feature, specText(interview, new Date(interview.specAt ?? now))) + (await guidance(settings, rulesFirst));
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
        summary: summary.slice(0, 2000),
        checks: checks.map((c) => ({ name: c.name, passed: c.passed, advisory: c.advisory ?? false, detail: c.detail ?? '' })),
        pictures: shots.pictures,
      });
    } finally {
      log.close();
    }
  }
  return {
    runId,
    run,
    using,
    steps,
    summary: summary.slice(0, 2000),
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

/**
 * Records one model run in its health record (only when a data folder is set). Returns true when
 * this failure switched the tool off: OFF_AFTER failures in a row (D-2). Off never uninstalls.
 */
async function noteRun(settings: AppSettings, tool: string, run: { ok: boolean; error?: string }, now: Date): Promise<boolean> {
  if (!settings.dataFolder) return false;
  const m = await import('@aip/memory');
  let h = m.recordRun(await m.readHealth(settings.dataFolder, tool), run, now);
  const off = !run.ok && !h.off && h.consecutiveFailures >= OFF_AFTER;
  if (off) h = m.switchOff(h, `${OFF_AFTER} failures in a row (last: ${h.failures.at(-1)?.error ?? 'unknown'}).`, now);
  await m.writeHealth(settings.dataFolder, h);
  return off;
}

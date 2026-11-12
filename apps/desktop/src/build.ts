import { engine, type Invoke } from './engine';

/** Makes a Tauri Channel that calls `onMessage` for each value Rust sends. Injected for tests. */
export type MakeChannel = <T>(onMessage: (message: T) => void) => unknown;

export interface RunInfo { path: string; branch: string; feature: string; base: string }
export interface BuildStep { text: string; refused?: string }
/** The build's own page while the model works (V2 A); url is null while there's nothing to show. */
export interface LiveView { url: string | null; note: string; reloads: boolean }
export type BuildEvent = { type: 'using'; using: string; run: RunInfo; advice?: string[] } | ({ type: 'step' } & BuildStep) | ({ type: 'live' } & LiveView);

/**
 * One finding: the one shape for every check result. Only 'block' stops Keep; 'warn' is advice,
 * 'info' is a note (or a check that couldn't run), 'pass' found nothing.
 */
export type FindingLevel = 'pass' | 'info' | 'warn' | 'block';
export interface Finding { check: string; level: FindingLevel; title: string; detail?: string; file?: string; line?: number; source: 'tool' | 'model' | 'rule' }

/** Worst first: what stops Keep, then advice, then notes, then what passed. */
export const LEVEL_ORDER: readonly FindingLevel[] = ['block', 'warn', 'info', 'pass'];
export const LEVEL_HEADING: Record<FindingLevel, string> = {
  block: 'Stops Keep',
  warn: 'Advice (doesn’t stop Keep)',
  info: 'Notes',
  pass: 'Passed',
};

/** The findings of one level, in the order found. */
export function findingsAt(findings: Finding[], level: FindingLevel): Finding[] {
  return findings.filter((f) => f.level === level);
}

export type CoverageStatus = 'tested' | 'failed' | 'not-checked';
export interface DoneLine { id: string; text: string; status: CoverageStatus }

/** The done-list lines out of a build's coverage finding. null for an old row or a feature with no lines. */
export function doneList(findings: Finding[]): DoneLine[] | null {
  const f = findings.find((x) => x.check === 'done-list');
  if (!f?.detail) return null;
  const out: DoneLine[] = [];
  for (const line of f.detail.split('\n')) {
    const m = /^(D\d+) (✓ tested|✗ failed|– not checked): (.*)$/.exec(line);
    if (m) out.push({ id: m[1]!, text: m[3]!, status: m[2] === '✓ tested' ? 'tested' : m[2] === '✗ failed' ? 'failed' : 'not-checked' });
  }
  return out.length ? out : null;
}

export const DONE_MARK: Record<CoverageStatus, string> = { tested: '✓ tested', failed: '✗ failed', 'not-checked': '– not checked' };

/** "2 of 5 done-list lines were never checked". */
export function neverCheckedLine(lines: DoneLine[]): string {
  return `${lines.filter((l) => l.status === 'not-checked').length} of ${lines.length} done-list lines were never checked`;
}

/** Something the model's summary claims, beside what the app found (V2 B). null: the app didn't check it. */
export interface Claim { topic: string; agrees: boolean | null; note: string }

export interface BuildResult {
  run: RunInfo;
  using: string;
  /** CI-4: what real builds say about this way of building (advice only). */
  advice?: string[];
  steps: BuildStep[];
  /** The model's own words; not checked by the app. */
  summary: string;
  claims: Claim[];
  /** D: what the model had to guess; joshua can answer from the build's issue on his phone. */
  questions?: string[];
  modelName: string;
  costText: string;
  /** The project's tests after the build and any fix attempts. */
  tests: { passed: boolean; output: string; fixAttempts: number };
  /** How the data folder sync went ('' with no data folder). */
  synced: string;
  /** The saved build that Keep, Undo and the rating act on. */
  runId: number | null;
  findings: Finding[];
  keep: { keep: boolean; blocking: string[] };
  /** Desktop and phone pictures (9c). */
  pictures: { name: string; path: string; dataUrl: string }[];
  screensChanged: boolean | null;
  picturesNote: string;
  /** How the phone message went (step 10b). */
  phone: string;
}

/** A saved feature build (step 9a). */
export interface BuildRun {
  id: number;
  at: string;
  slug: string;
  feature: string;
  path: string;
  branch: string;
  model: string;
  costUsd: number | null;
  testsPassed: boolean;
  fixAttempts: number;
  summary: string;
  status: 'running' | 'built' | 'kept' | 'undone' | 'failed' | 'stopped' | 'interrupted';
  rating: number | null;
  keptInto: string;
  /** Why a failed build failed; null for the rest. */
  cause?: 'model' | 'tool' | 'budget' | 'network' | 'provider' | 'setup' | 'stopped' | 'unknown' | null;
  /** The plain message of a failed, stopped or interrupted build. */
  error?: string;
  /** Set once the unfinished build's copy was removed. */
  decidedAt?: string | null;
  findings: Finding[];
}

/** Why a build failed, in plain words (the same words as the tools' health records). */
export function causeText(cause: BuildRun['cause']): string {
  switch (cause) {
    case 'model': return 'the model got it wrong';
    case 'tool': return 'the tool failed';
    case 'budget': return 'the run hit its cost limit';
    case 'network': return 'the internet connection dropped';
    case 'provider': return 'the provider was busy or down';
    case 'setup': return 'the API key or credit needs attention';
    case 'stopped': return 'you stopped it';
    default: return 'the cause isn’t clear';
  }
}

/** True for a build that ended without finishing: it has a record, but can't be kept. */
export function endedEarly(r: BuildRun): boolean {
  return r.status === 'failed' || r.status === 'stopped' || r.status === 'interrupted';
}

/** What the build cost so far, "£0.05 ($0.06)", or "cost not recorded". */
export function costSoFar(usd: number | null, gbpPerUsd: number): string {
  if (usd === null) return 'cost not recorded';
  return `£${(usd * gbpPerUsd).toFixed(2)} ($${usd.toFixed(2)})`;
}

/** The plain line for a failed, stopped, interrupted or running build. */
export function endedWords(r: BuildRun): string {
  if (r.status === 'running') return 'still running (or the app was closed)';
  if (r.status === 'stopped') return 'stopped: you stopped it';
  if (r.status === 'interrupted') return 'interrupted: the app was closed while it was running';
  return `failed: ${causeText(r.cause ?? 'unknown')}`;
}

/** True when nothing stops Keep: tests pass and no blocking check failed. */
export function keepable(r: BuildRun): boolean {
  return r.testsPassed && !r.findings.some((f) => f.level === 'block');
}

export const CHECK_NAME: Record<string, string> = { secrets: 'Secret scan', audit: 'Package audit', dependencies: 'New packages', checklist: 'Checklist rules', axe: 'Accessibility', 'phone-overflow': 'Phone width', pictures: 'Pictures' };

/** After Keep, Undo or a rating: what happened, and any habit the app learned (step 9d). */
export interface Decided { run: BuildRun; note: string; learned: string[]; phone: string }
export interface Rated { run: BuildRun; learned: string[] }

const plain = (err: unknown) => new Error(err instanceof Error ? err.message : String(err));

/** Builds one feature; each step arrives through `onEvent` while it runs. Costs money. */
export async function startBuild(
  invoke: Invoke,
  makeChannel: MakeChannel,
  slug: string,
  feature: string,
  onEvent: (e: BuildEvent) => void,
): Promise<BuildResult> {
  try {
    return await invoke<BuildResult>('build_feature', { slug, feature, onStep: makeChannel<BuildEvent>(onEvent) });
  } catch (err) {
    throw plain(err);
  }
}

/** Stops the running build. False if none was running. */
export async function stopBuild(invoke: Invoke): Promise<boolean> {
  try {
    return await invoke<boolean>('build_stop');
  } catch (err) {
    throw plain(err);
  }
}

/** CI-4: one way of building (the build model plus the app's fixed steps) and how it has done. */
export interface WorkflowConfidence { level: 'low' | 'medium' | 'high'; counted: number; lastBuild: string; failed: number; notCounted: number; text: string }
export interface WorkflowRow { model: string; name: string; text: string; finished: number; kept: number; safetyFailures: number; confidence: WorkflowConfidence }

/** How each way of building has done in real builds on this computer. */
export async function compareWorkflows(invoke: Invoke): Promise<WorkflowRow[]> {
  try {
    return await engine<WorkflowRow[]>(invoke, 'workflow_compare');
  } catch (err) {
    throw plain(err);
  }
}

/** Saved builds for a project, newest first. */
export async function listRuns(invoke: Invoke, slug: string): Promise<BuildRun[]> {
  try {
    return await engine<BuildRun[]>(invoke, 'run_list', { slug });
  } catch (err) {
    throw plain(err);
  }
}

/** Keep merges the build into joshua's own copy (never pushes); Undo removes the build's copy. */
export async function decideRun(invoke: Invoke, id: number, keep: boolean): Promise<Decided> {
  try {
    return await invoke<Decided>('run_decide', { id, keep });
  } catch (err) {
    throw plain(err);
  }
}

/** True when the only thing stopping Keep is new packages waiting for joshua's OK. */
export function needsPackageOk(r: BuildRun): boolean {
  return r.status === 'built' && r.testsPassed && r.findings.some((f) => f.check === 'dependencies' && f.level === 'block');
}

/** joshua's OK for the new packages a build added. After this, Keep is allowed (if nothing else blocks). */
export async function approvePackages(invoke: Invoke, id: number): Promise<{ run: BuildRun; note: string; keep: { keep: boolean; blocking: string[] } }> {
  try {
    return await engine(invoke, 'deps_approve', { id });
  } catch (err) {
    throw plain(err);
  }
}

export async function rateRun(invoke: Invoke, id: number, rating: number): Promise<Rated> {
  try {
    return await engine<Rated>(invoke, 'run_rate', { id, rating });
  } catch (err) {
    throw plain(err);
  }
}

/** Something that needs joshua (step 10b), with its GitHub issue when it was posted. */
export interface WorkItem {
  id: number;
  at: string;
  kind: 'build';
  runId: number;
  title: string;
  issue: number;
  issueUrl: string;
}

/** The "Needs you" panel: open items, oldest first. */
export async function listWork(invoke: Invoke): Promise<WorkItem[]> {
  try {
    return await engine<WorkItem[]>(invoke, 'work_list');
  } catch (err) {
    throw plain(err);
  }
}

/** Reads replies from joshua's phone now and acts on keep, undo or a rating (step 10c). */
export async function pollPhone(invoke: Invoke): Promise<{ done: string[]; changed: boolean }> {
  try {
    return await invoke<{ done: string[]; changed: boolean }>('work_poll');
  } catch (err) {
    throw plain(err);
  }
}

/** A command a build wanted to run that a rule says to ask joshua about first. */
export interface AskRequest {
  id: number;
  at: string;
  slug: string;
  feature: string;
  branch: string;
  tool: string;
  /** The exact command or file path. */
  input: string;
  reason: string;
}

/** The ask-first requests waiting in the "Needs you" panel, oldest first. */
export async function listAsks(invoke: Invoke): Promise<AskRequest[]> {
  try {
    return await engine<AskRequest[]>(invoke, 'ask_list');
  } catch (err) {
    throw plain(err);
  }
}

/** Allow once lets that exact thing through one time (for 24 hours); No closes the request. */
export async function decideAsk(invoke: Invoke, id: number, allow: boolean): Promise<{ note: string }> {
  try {
    return await engine<{ note: string }>(invoke, 'ask_decide', { id, allow });
  } catch (err) {
    throw plain(err);
  }
}

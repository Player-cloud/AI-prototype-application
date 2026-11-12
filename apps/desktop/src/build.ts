import type { Invoke } from './engine';

/** Makes a Tauri Channel that calls `onMessage` for each value Rust sends. Injected for tests. */
export type MakeChannel = <T>(onMessage: (message: T) => void) => unknown;

export interface RunInfo { path: string; branch: string; feature: string; base: string }
export interface BuildStep { text: string; refused?: string }
/** The build's own page while the model works (V2 A); url is null while there's nothing to show. */
export interface LiveView { url: string | null; note: string; reloads: boolean }
export type BuildEvent = { type: 'using'; using: string; run: RunInfo; advice?: string[] } | ({ type: 'step' } & BuildStep) | ({ type: 'live' } & LiveView);

/** One free check (9b). Advice-only checks don't stop Keep. */
export interface Check { name: string; passed: boolean; advisory?: boolean; detail?: string }

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
  checks: Check[];
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
  status: 'built' | 'kept' | 'undone';
  rating: number | null;
  keptInto: string;
  checks: Check[];
}

/** True when nothing stops Keep: tests pass and no blocking check failed. */
export function keepable(r: BuildRun): boolean {
  return r.testsPassed && !r.checks.some((c) => !c.passed && !c.advisory);
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
export interface WorkflowRow { model: string; name: string; text: string; finished: number; kept: number; safetyFailures: number }

/** How each way of building has done in real builds on this computer. */
export async function compareWorkflows(invoke: Invoke): Promise<WorkflowRow[]> {
  try {
    return await invoke<WorkflowRow[]>('workflow_compare');
  } catch (err) {
    throw plain(err);
  }
}

/** Saved builds for a project, newest first. */
export async function listRuns(invoke: Invoke, slug: string): Promise<BuildRun[]> {
  try {
    return await invoke<BuildRun[]>('run_list', { slug });
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
  return r.status === 'built' && r.testsPassed && r.checks.some((c) => c.name === 'dependencies' && !c.passed && !c.advisory);
}

/** joshua's OK for the new packages a build added. After this, Keep is allowed (if nothing else blocks). */
export async function approvePackages(invoke: Invoke, id: number): Promise<{ run: BuildRun; note: string; keep: { keep: boolean; blocking: string[] } }> {
  try {
    return await invoke('deps_approve', { id });
  } catch (err) {
    throw plain(err);
  }
}

export async function rateRun(invoke: Invoke, id: number, rating: number): Promise<Rated> {
  try {
    return await invoke<Rated>('run_rate', { id, rating });
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
    return await invoke<WorkItem[]>('work_list');
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
    return await invoke<AskRequest[]>('ask_list');
  } catch (err) {
    throw plain(err);
  }
}

/** Allow once lets that exact thing through one time (for 24 hours); No closes the request. */
export async function decideAsk(invoke: Invoke, id: number, allow: boolean): Promise<{ note: string }> {
  try {
    return await invoke<{ note: string }>('ask_decide', { id, allow });
  } catch (err) {
    throw plain(err);
  }
}

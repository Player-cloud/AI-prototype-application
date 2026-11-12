/**
 * CI-4: workflow comparisons feed the engine's picks. Before a build the engine looks at how each
 * way of building has done in real builds (kept, defects, cost, time, Undo) and says so beside the
 * Using line. It only advises: the model for each job is joshua's rule, so the engine never
 * switches on a score. It suggests another way only when that one has clearly done better over
 * enough builds and never had a safety failure; otherwise the simplest way that works stays.
 */
import type { WorkflowStats } from '@aip/memory';
import { formatCost } from './money.ts';
import type { AppSettings } from './settings.ts';

/** Fewer finished builds than this is a first look, not proof (same as the repeatable tests). */
export const ENOUGH_BUILDS = 3;
/** Another way must keep at least this much more of its builds before it's suggested. */
export const CLEARLY_BETTER = 0.2;

/**
 * How sure the advice is. "Counted" builds are the ones that count for or against a way of
 * building: finished (kept or undone) plus failed by the model's or tool's fault.
 *  - low: fewer than `lowBelow` counted builds, or the last build is older than `staleDays`.
 *  - high: at least `highAt` counted builds and the last build is within `freshDays`.
 *  - medium: anything else.
 * It is shown beside the advice only. It never changes which model the engine picks.
 */
export const CONFIDENCE = { lowBelow: 3, highAt: 10, staleDays: 30, freshDays: 14 } as const;

export type ConfidenceLevel = 'low' | 'medium' | 'high';

export interface Confidence {
  level: ConfidenceLevel;
  /** Finished plus failed-by-model builds. */
  counted: number;
  /** Date of the newest build, as UTC "3 Nov 2026"; '' when unknown. */
  lastBuild: string;
  failed: number;
  notCounted: number;
  kept: number;
  /** Total cost (failed builds included) divided by kept builds; null when nothing is kept or no cost was recorded. */
  costPerKeptUsd: number | null;
  /** Plain words for the screen, with money in £ and $. */
  text: string;
}

export interface WorkflowRow extends WorkflowStats {
  name: string;
  confidence: Confidence;
  /** Plain words for the screen, with money in £ and $. */
  text: string;
}

const money = (usd: number, gbpPerUsd: number) => (usd * gbpPerUsd < 0.005 ? 'under £0.01 (under $0.01)' : formatCost(usd, gbpPerUsd));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** UTC, so the same build shows the same date on every computer. "3 Nov" or "3 Nov 2026". */
export function shortDate(iso: string, withYear = false): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${withYear ? ` ${d.getUTCFullYear()}` : ''}`;
}

/** The level for a number of counted builds and the age of the last one (days; NaN means unknown). */
export function confidenceLevel(counted: number, ageDays: number): ConfidenceLevel {
  if (counted < CONFIDENCE.lowBelow || !(ageDays <= CONFIDENCE.staleDays)) return 'low';
  if (counted >= CONFIDENCE.highAt && ageDays <= CONFIDENCE.freshDays) return 'high';
  return 'medium';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function workflowConfidence(s: WorkflowStats, gbpPerUsd: number, now: Date = new Date()): Confidence {
  const counted = s.finished + s.failed;
  const last = new Date(s.lastAt).getTime();
  const ageDays = Number.isNaN(last) ? Number.NaN : Math.max(0, (now.getTime() - last) / 86_400_000);
  const level = confidenceLevel(counted, ageDays);
  // Total cost includes failed builds, so a way that fails a lot costs more per kept build.
  const costPerKeptUsd = s.costUsd !== null && s.kept > 0 ? s.costUsd / s.kept : null;
  const lastBuild = shortDate(s.lastAt, true);
  const text =
    `${level[0]!.toUpperCase()}${level.slice(1)} confidence: ${plural(counted, 'build')} counted, last build ${lastBuild || 'unknown'}, ` +
    `${s.failed} failed (model or tool fault), ${s.notCounted} not counted, ` +
    (costPerKeptUsd !== null ? `${money(costPerKeptUsd, gbpPerUsd)} per kept build (failed builds included).` : s.kept > 0 ? 'cost not recorded.' : 'no kept builds yet.');
  return { level, counted, lastBuild, failed: s.failed, notCounted: s.notCounted, kept: s.kept, costPerKeptUsd, text };
}

const minutes = (ms: number) => (ms < 60_000 ? 'under a minute' : `about ${Math.round(ms / 60_000)} min`);
const rate = (s: WorkflowStats) => (s.finished ? s.kept / s.finished : 0);

/** One line per workflow: "Sonnet 5.5: 4 of 5 builds kept, …". */
export function workflowText(s: WorkflowStats, name: string, gbpPerUsd: number): string {
  const parts = [
    s.finished ? `${s.kept} of ${s.finished} builds kept` : 'no build kept or undone yet',
    s.undone ? `${s.undone} undone` : '',
    s.waiting ? `${s.waiting} waiting` : '',
    s.failed ? `${s.failed} failed (the model’s or tool’s fault)` : '',
    s.notCounted ? `${s.notCounted} ended early for another reason (not counted)` : '',
    `tests passed first time in ${s.testsFirstTime} of ${s.finished + s.waiting}`,
    `${s.defects} problem${s.defects === 1 ? '' : 's'} found by the app’s checks`,
    s.safetyFailures ? `the secret scan found something in ${s.safetyFailures}` : '',
    s.costPerKeptUsd !== null ? `${money(s.costPerKeptUsd, gbpPerUsd)} per kept build` : s.costUsd !== null ? `${money(s.costUsd, gbpPerUsd)} in all, nothing kept yet` : 'cost not recorded',
    s.avgMs !== null ? `${minutes(s.avgMs)} each` : 'time not recorded',
    s.rating !== null ? `your rating ${s.rating} (${s.rated} rated)` : '',
  ].filter(Boolean);
  const sure = s.finished < ENOUGH_BUILDS ? ' A first look, not proof.' : '';
  return `${name}: ${parts.join(', ')}.${sure}`;
}

/**
 * What the evidence says about the way the engine is about to build. Never changes the pick.
 * `current` is the model the engine picked; `stats` are every workflow's results.
 */
export function workflowAdvice(current: string, stats: WorkflowStats[], nameOf: (id: string) => string, gbpPerUsd: number, now: Date = new Date()): string[] {
  const mine = stats.find((s) => s.model === current);
  const name = nameOf(current);
  if (!mine || mine.finished + mine.waiting + mine.failed + mine.notCounted === 0) return [`No builds with ${name} yet, so this way of building is untested.`];
  const conf = workflowConfidence(mine, gbpPerUsd, now);
  const prefix = `${conf.level[0]!.toUpperCase()}${conf.level.slice(1)} confidence (${plural(conf.counted, 'build')}, last ${shortDate(mine.lastAt) || 'unknown'}):`;
  const out = [`${prefix} Evidence: ${workflowText(mine, name, gbpPerUsd)}`, conf.text];
  // Confidence is shown only. The suggestion rule below never reads it.
  if (mine.finished < ENOUGH_BUILDS) return out;
  const better = stats
    .filter((s) => s.model !== current && s.finished >= ENOUGH_BUILDS && s.safetyFailures === 0 && rate(s) >= rate(mine) + CLEARLY_BETTER)
    .sort((a, b) => rate(b) - rate(a) || a.model.localeCompare(b.model))[0];
  if (better) {
    out.push(
      `Suggestion: ${nameOf(better.model)} kept more builds (${better.kept} of ${better.finished}, against ${mine.kept} of ${mine.finished}). ` +
        `The app still uses ${name}, because the model for each job is your choice. Change it only if you agree.`,
    );
  }
  return out;
}

/** Every build workflow on this computer, for the Build screen. */
export async function compareWorkflows(settings: AppSettings, dbPath: string, nameOf: (id: string) => Promise<string>, now: Date = new Date()): Promise<WorkflowRow[]> {
  const m = await import('@aip/memory');
  const log = m.RunLog.open(dbPath);
  let runs: import('@aip/memory').Run[];
  try {
    runs = log.list(undefined, m.KEEP_RUNS);
  } finally {
    log.close();
  }
  const rows: WorkflowRow[] = [];
  for (const s of m.workflowStats(runs)) {
    const name = await nameOf(s.model);
    rows.push({ ...s, name, confidence: workflowConfidence(s, settings.gbpPerUsd, now), text: workflowText(s, name, settings.gbpPerUsd) });
  }
  return rows;
}

/** The advice for a build about to start (empty without a history file). */
export async function adviceFor(dbPath: string | undefined, model: string, nameOf: (id: string) => Promise<string>, gbpPerUsd: number, now: Date = new Date()): Promise<string[]> {
  if (!dbPath) return [];
  const m = await import('@aip/memory');
  const log = m.RunLog.open(dbPath);
  let runs: import('@aip/memory').Run[];
  try {
    runs = log.list(undefined, m.KEEP_RUNS);
  } finally {
    log.close();
  }
  const stats = m.workflowStats(runs);
  const names = new Map<string, string>();
  for (const s of stats) names.set(s.model, await nameOf(s.model));
  names.set(model, await nameOf(model));
  return workflowAdvice(model, stats, (id) => names.get(id) ?? id, gbpPerUsd, now);
}

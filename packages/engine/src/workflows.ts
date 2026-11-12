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

export interface WorkflowRow extends WorkflowStats {
  name: string;
  /** Plain words for the screen, with money in £ and $. */
  text: string;
}

const money = (usd: number, gbpPerUsd: number) => (usd * gbpPerUsd < 0.005 ? 'under £0.01 (under $0.01)' : formatCost(usd, gbpPerUsd));
const minutes = (ms: number) => (ms < 60_000 ? 'under a minute' : `about ${Math.round(ms / 60_000)} min`);
const rate = (s: WorkflowStats) => (s.finished ? s.kept / s.finished : 0);

/** One line per workflow: "Sonnet 5.5: 4 of 5 builds kept, …". */
export function workflowText(s: WorkflowStats, name: string, gbpPerUsd: number): string {
  const parts = [
    s.finished ? `${s.kept} of ${s.finished} builds kept` : 'no build kept or undone yet',
    s.undone ? `${s.undone} undone` : '',
    s.waiting ? `${s.waiting} waiting` : '',
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
export function workflowAdvice(current: string, stats: WorkflowStats[], nameOf: (id: string) => string, gbpPerUsd: number): string[] {
  const mine = stats.find((s) => s.model === current);
  const name = nameOf(current);
  if (!mine || mine.finished + mine.waiting === 0) return [`No builds with ${name} yet, so this way of building is untested.`];
  const out = [`Evidence: ${workflowText(mine, name, gbpPerUsd)}`];
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
export async function compareWorkflows(settings: AppSettings, dbPath: string, nameOf: (id: string) => Promise<string>): Promise<WorkflowRow[]> {
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
    rows.push({ ...s, name, text: workflowText(s, name, settings.gbpPerUsd) });
  }
  return rows;
}

/** The advice for a build about to start (empty without a history file). */
export async function adviceFor(dbPath: string | undefined, model: string, nameOf: (id: string) => Promise<string>, gbpPerUsd: number): Promise<string[]> {
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
  return workflowAdvice(model, stats, (id) => names.get(id) ?? id, gbpPerUsd);
}

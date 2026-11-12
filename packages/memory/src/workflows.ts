/**
 * CI-4: whole-workflow results from real builds. A build workflow is the model that built it plus
 * the app's fixed steps (tests, up to 2 fixes, free checks, pictures). Each is measured end to end:
 * how many builds were kept, defects the app's checks found, cost, time, and how often joshua had
 * to step in (Undo). Missing numbers stay missing; joshua's 1–5 rating is kept apart from the rest.
 * memory measures; the engine decides what, if anything, to suggest.
 */
import { countsAgainst, type FailureCause } from './health.js';
import type { Run } from './runlog.js';

export interface WorkflowStats {
  /** The workflow's key: the build model's ID. */
  model: string;
  /** Builds joshua decided on (kept or undone). Waiting builds aren't counted as either. */
  finished: number;
  kept: number;
  /** Undo: joshua stepped in and threw the build away. */
  undone: number;
  waiting: number;
  /** Builds that failed because of the model's or tool's own fault. These count against the way of building. */
  failed: number;
  /** Builds that failed, stopped or were interrupted for another reason (cost limit, network, a Stop...). Shown, not counted. */
  notCounted: number;
  /** Builds whose tests passed with no fix attempts. */
  testsFirstTime: number;
  /** Failing app checks that stop Keep, over all builds (advice-only and not-run checks don't count). */
  defects: number;
  /** Builds where the secret scan found something. A safety failure is never outweighed. */
  safetyFailures: number;
  /** Total known cost, and cost per kept build; null when no cost was recorded. */
  costUsd: number | null;
  costPerKeptUsd: number | null;
  /** Average build time; null when no build was timed. */
  avgMs: number | null;
  /** joshua's average 1–5 rating and how many he rated: separate, never mixed into the rest. */
  rating: number | null;
  rated: number;
  /** Newest build. */
  lastAt: string;
}

/** A failed build counts against the way of building only for the same causes as the health record. */
const isCounted = (r: Run) => r.status === 'failed' && countsAgainst((r.cause ?? 'unknown') as FailureCause);
const ended = (r: Run) => r.status === 'failed' || r.status === 'stopped' || r.status === 'interrupted';

const SAFETY = new Set(['secrets']);
const notRun = (detail?: string) => (detail ?? '').startsWith('Not run');

/** One row per build model, most-used first. */
export function workflowStats(runs: Run[]): WorkflowStats[] {
  const by = new Map<string, Run[]>();
  // A build still running has nothing to measure yet.
  for (const r of runs) if (r.status !== 'running') by.set(r.model, [...(by.get(r.model) ?? []), r]);
  const out: WorkflowStats[] = [];
  for (const [model, all] of by) {
    // Builds that ended early have no tests, checks or timing to measure: only their cost and cause count.
    const rs = all.filter((r) => !ended(r));
    const kept = rs.filter((r) => r.status === 'kept').length;
    const undone = rs.filter((r) => r.status === 'undone' || r.status === 'reverted').length;
    const costs = all.map((r) => r.costUsd).filter((c): c is number => typeof c === 'number');
    const times = rs.map((r) => r.ms).filter((m): m is number => typeof m === 'number');
    const ratings = rs.map((r) => r.rating).filter((n): n is number => typeof n === 'number');
    const costUsd = costs.length ? costs.reduce((a, b) => a + b, 0) : null;
    out.push({
      model,
      finished: kept + undone,
      kept,
      undone,
      failed: all.filter(isCounted).length,
      notCounted: all.filter((r) => ended(r) && !isCounted(r)).length,
      waiting: rs.filter((r) => r.status === 'built').length,
      testsFirstTime: rs.filter((r) => r.testsPassed && r.fixAttempts === 0).length,
      defects: rs.reduce((n, r) => n + r.findings.filter((f) => f.level === 'block' && !notRun(f.detail)).length + (r.testsPassed ? 0 : 1), 0),
      safetyFailures: rs.filter((r) => r.findings.some((f) => SAFETY.has(f.check) && (f.level === 'block' || f.level === 'warn') && !notRun(f.detail))).length,
      costUsd,
      costPerKeptUsd: costUsd !== null && kept > 0 ? costUsd / kept : null,
      avgMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
      rating: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null,
      rated: ratings.length,
      lastAt: all.map((r) => r.at).sort().at(-1) ?? '',
    });
  }
  return out.sort((a, b) => b.finished + b.waiting + b.failed + b.notCounted - (a.finished + a.waiting + a.failed + a.notCounted) || b.lastAt.localeCompare(a.lastAt));
}

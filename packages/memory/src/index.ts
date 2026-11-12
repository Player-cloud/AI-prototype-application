/**
 * Memory: summaries first, full notes only when needed (~93% fewer tokens in trial round 1).
 * Notes link to each other with [[name]]; the engine follows links instead of reading everything.
 */

export interface Note { name: string; description: string; body: string }

export function links(note: Note): string[] {
  return [...new Set([...note.body.matchAll(/\[\[([a-z0-9-]+)\]\]/gi)].map((m) => m[1]!))];
}

/** Index of one-line descriptions: what the engine reads first. */
export function summaryIndex(notes: Note[]): string {
  return notes.map((n) => `- ${n.name}: ${n.description}`).join('\n');
}

/** Notes reachable from a start note within `depth` link hops. */
export function related(notes: Note[], start: string, depth = 1): Note[] {
  const byName = new Map(notes.map((n) => [n.name, n]));
  const seen = new Set([start]);
  let frontier = [start];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const name of frontier) for (const l of links(byName.get(name) ?? { name, description: '', body: '' })) if (!seen.has(l) && byName.has(l)) { seen.add(l); next.push(l); }
    frontier = next;
  }
  return [...seen].map((n) => byName.get(n)).filter((n): n is Note => !!n);
}

export {
  bullets,
  firstRead,
  joinTools,
  toolClashes,
  toolIdFor,
  loadDataRepo,
  parseLedger,
  roughTokens,
  toolState,
  type DataRepo,
  type LedgerEntry,
  type ToolState,
  type ToolView,
} from './data-repo.js';

export { SpendLog, monthKey, type MonthSpend, type SpendRecord } from './spend.js';

export { HEADING as LEARNED_HEADING, MIN_BUILDS, MIN_REPEATS, applyLearned, learnHabits, type HabitChanges, type Learned } from './learn.js';

export { KEEP_ITEMS, WorkItems, type WorkItem, type WorkKind } from './workitems.js';

export { KEEP_RUNS, RunLog, type NewRun, type Run, type RunCheck, type RunPicture, type RunStatus } from './runlog.js';

export { ChangeLog, KEEP_CHANGES, MAX_CHANGE_CHARS, type Change, type ChangeKind, type NewChange } from './history.js';

export { SLUG, listProjectSlugs, readProjectJson, slugify, writeProjectFiles } from './projects.js';

export { changedFiles, looksLikeKey, rateTool, realGit, setRating, syncDataRepo, type Git, type SyncResult } from './sync.js';

export {
  KEEP_FAILURES,
  checkHealth,
  emptyHealth,
  healthNote,
  listHealth,
  noteVersion,
  readHealth,
  recordRun,
  switchOff,
  switchOn,
  writeHealth,
  type ToolFailure,
  type ToolHealth,
} from './health.js';

export { KEEP_EVALS, SCREENING_BELOW, addEvals, evidenceNote, listEvals, readEvals, type StoredEval } from './evals.js';
export { workflowStats, type WorkflowStats } from './workflows.js';

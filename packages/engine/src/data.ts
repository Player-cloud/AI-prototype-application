/** What the Tools screen shows: the data repo's tools, habits and rules, read through the memory package. */
import type { ToolHealth, ToolState } from '@aip/memory';
import type { AppSettings } from './settings.ts';
import { fileChanged, isInside, undoLabel } from './history.ts';
import { readEnvironments } from './environment.ts';

export interface ToolRow {
  /** CI-1: the stable ID (card file name, or the name as a slug). */
  id: string;
  name: string;
  /** model, tool, plugin, skill, mod, agent, workflow, or unknown when the card doesn't say. */
  kind: string;
  /** The version in use and the one its evidence is for; null when never seen. */
  version: string | null;
  testedVersion: string | null;
  /** CI-2: the version on each computer that has used it, when there's more than one: "joshu 4.14.0 · lapto 4.15.0". */
  byComputer: string;
  /** CI-3: the latest repeatable-test results and how sure they are; '' when never tested. */
  tested: string;
  /** CI-5: tests that did worse after an update ('' when none). */
  regression: string;
  /** Whether a free test exists for it (so it can be tested and experimented on). */
  testable: boolean;
  state: ToolState;
  status: string;
  job: string;
  evidence: string;
  rating: string;
  what: string;
  useWhen: string;
  dontUseWhen: string;
  cost: string;
  /** Tool health in plain words ('' when all is well), and the flags behind it. */
  health: string;
  stale: boolean;
  failuresInRow: number;
  switchedOff: boolean;
}

export type DataOverview =
  | { configured: false }
  | {
      configured: true;
      folder: string;
      tools: ToolRow[];
      habits: string[];
      ruleCount: number;
      noteCount: number;
      firstReadTokens: number;
      allTokens: number;
      /** CI-2: this computer's ID, every computer's last check, and what differs between them. */
      computer: string;
      environments: import('@aip/checks').Environment[];
      differences: string[];
      /** Duplicate or clashing tools in the ledger and cards (advice only). */
      clashes: string[];
      /** CI-5: the newest experiments, newest first. All proposals until joshua adopts one. */
      experiments: { id: string; capability: string; question: string; verdict: string; at: string; status: string }[];
    };

function folderOf(settings: AppSettings): string {
  if (!settings.dataFolder) throw new Error('Set your data folder in Settings first.');
  return settings.dataFolder;
}

/**
 * Saves joshua's 1–5 rating for a tool in ledger.md, keeps the change in the history (when
 * dbPath is given) so it can be undone, then syncs the data repo to GitHub.
 */
export async function rateAndSync(settings: AppSettings, tool: string, rating: number, dbPath: string | null = null, now = new Date()) {
  const folder = folderOf(settings);
  const m = await import('@aip/memory');
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const ledger = join(folder, 'ledger.md');
  const before = dbPath ? await readFile(ledger, 'utf8') : '';
  await m.rateTool(folder, tool, rating);
  if (dbPath) await fileChanged(dbPath, ledger, before, await readFile(ledger, 'utf8'), `Rated ${tool} ${rating}/5`, now);
  return m.syncDataRepo(folder, `Rate ${tool} ${rating}/5`);
}

/** After an undo puts back a data-folder file, sync it. A failed sync doesn't undo the undo. */
export async function syncAfterUndo(settings: AppSettings, path: string, label: string): Promise<string> {
  if (!isInside(settings.dataFolder, path)) return '';
  const m = await import('@aip/memory');
  try {
    return (await m.syncDataRepo(settings.dataFolder, undoLabel(label))).summary;
  } catch (err) {
    return `Saved here, but not synced yet: ${(err as Error).message}`;
  }
}

/** Commits any changes in the data folder and syncs with GitHub (both ways). */
export async function syncNow(settings: AppSettings) {
  const m = await import('@aip/memory');
  return m.syncDataRepo(folderOf(settings), 'Update from AI Prototype');
}

export async function dataOverview(settings: AppSettings): Promise<DataOverview> {
  if (!settings.dataFolder) return { configured: false };
  const m = await import('@aip/memory');
  const repo = await m.loadDataRepo(settings.dataFolder);
  const health = await m.listHealth(settings.dataFolder);
  const healthOf = (t: { id: string; name: string }) => health.get(t.id) ?? m.emptyHealth(t.name, t.id);
  const c = await import('@aip/checks');
  const environments = await readEnvironments(settings.dataFolder);
  const evals = await m.listEvals(settings.dataFolder);
  return {
    configured: true,
    folder: repo.folder,
    tools: [...repo.tools, ...healthOnly(repo.tools.map((t) => t.id), health)].map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.card?.kind ?? 'unknown',
      version: healthOf(t).version ?? (t.card?.version || null),
      testedVersion: healthOf(t).testedVersion,
      byComputer: byComputer(healthOf(t)),
      tested: m.evidenceNote(evals.get(t.id) ?? []),
      regression: m.regressionNote(m.findRegressions(evals.get(t.id) ?? [])),
      testable: c.SUITES.some((x) => x.free && x.capability === t.id),
      state: t.state,
      status: t.status,
      job: t.job,
      evidence: t.evidence,
      rating: t.rating,
      what: t.card?.what ?? '',
      useWhen: t.card?.useWhen ?? '',
      dontUseWhen: t.card?.dontUseWhen ?? '',
      cost: t.card?.cost ?? '',
      health: m.healthNote(healthOf(t)),
      stale: healthOf(t).stale,
      failuresInRow: healthOf(t).consecutiveFailures,
      switchedOff: healthOf(t).off !== null,
    })),
    habits: repo.habits,
    ruleCount: repo.rules.length,
    noteCount: repo.notes.length,
    firstReadTokens: m.roughTokens(m.firstRead(repo)),
    allTokens: m.roughTokens(repo.notes.map((n) => n.body).join('\n')),
    computer: c.computerId(),
    environments,
    differences: c.compareComputers(environments),
    clashes: m.toolClashes(repo.tools),
    experiments: (await m.listExperiments(settings.dataFolder)).slice(0, 10).map(({ id, capability, question, verdict, at, status }) => ({ id, capability, question, verdict, at, status })),
  };
}

/**
 * Notes the version of a tool in use (D-2: a new version marks old test evidence stale and
 * schedules a retest on its next use). Saved in the data folder; synced with the next sync.
 */
export async function noteToolVersion(settings: AppSettings, tool: string, version: string) {
  const folder = folderOf(settings);
  const m = await import('@aip/memory');
  const before = await m.readHealth(folder, tool, await idOf(folder, tool));
  const after = m.noteVersion(before, version);
  if (after !== before) await m.writeHealth(folder, after);
  return after;
}

/**
 * Tools with a health record but no ledger line yet (a build model, say), so a switched-off one
 * still shows on the Tools screen with its Switch back on button.
 */
function healthOnly(ids: string[], health: Map<string, ToolHealth>) {
  return [...health.entries()]
    .filter(([id]) => !ids.includes(id))
    .map(([id, h]) => ({ id, name: h.tool, state: 'unknown' as const, status: 'not in the ledger yet', job: 'Used by the app', evidence: '', rating: '', card: undefined }));
}

/** Switches a switched-off tool back on (D-2: it gets a quick retest on its next use), then syncs. */
export async function switchToolOn(settings: AppSettings, tool: string) {
  const folder = folderOf(settings);
  const m = await import('@aip/memory');
  const before = await m.readHealth(folder, tool, await idOf(folder, tool));
  if (!before.off) throw new Error(`${tool} isn’t switched off.`);
  await m.writeHealth(folder, m.switchOn(before));
  return m.syncDataRepo(folder, `Switch ${tool} back on`);
}

/** Records one use of a tool: success, or failure with its error. Saved in the data folder. */
export async function recordToolRun(settings: AppSettings, tool: string, run: { ok: boolean; error?: string }, now: Date) {
  const folder = folderOf(settings);
  const m = await import('@aip/memory');
  const after = m.recordRun(await m.readHealth(folder, tool, await idOf(folder, tool)), run, now);
  await m.writeHealth(folder, after);
  return after;
}

/** The stable ID for a tool name (CI-1): from the ledger and cards, else the name as a slug. */
async function idOf(folder: string, name: string): Promise<string> {
  const m = await import('@aip/memory');
  try {
    return m.toolIdFor((await m.loadDataRepo(folder)).tools, name);
  } catch {
    return m.slugify(name);
  }
}

/** "joshu 4.14.0 · lapto 4.15.0" when more than one computer has used the tool, else ''. */
function byComputer(h: ToolHealth): string {
  const entries = Object.entries(h.computers).filter(([, v]) => v.version);
  if (entries.length < 2) return '';
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k} ${v.version}${v.stale ? ' (retest due)' : ''}`)
    .join(' · ');
}

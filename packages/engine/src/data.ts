/** What the Tools screen shows: the data repo's tools, habits and rules, read through the memory package. */
import type { ToolState } from '@aip/memory';
import type { AppSettings } from './settings.ts';
import { fileChanged, isInside, undoLabel } from './history.ts';

export interface ToolRow {
  name: string;
  state: ToolState;
  status: string;
  job: string;
  evidence: string;
  rating: string;
  what: string;
  useWhen: string;
  dontUseWhen: string;
  cost: string;
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
  return {
    configured: true,
    folder: repo.folder,
    tools: repo.tools.map((t) => ({
      name: t.name,
      state: t.state,
      status: t.status,
      job: t.job,
      evidence: t.evidence,
      rating: t.rating,
      what: t.card?.what ?? '',
      useWhen: t.card?.useWhen ?? '',
      dontUseWhen: t.card?.dontUseWhen ?? '',
      cost: t.card?.cost ?? '',
    })),
    habits: repo.habits,
    ruleCount: repo.rules.length,
    noteCount: repo.notes.length,
    firstReadTokens: m.roughTokens(m.firstRead(repo)),
    allTokens: m.roughTokens(repo.notes.map((n) => n.body).join('\n')),
  };
}

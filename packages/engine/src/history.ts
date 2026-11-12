/**
 * One-click undo. Every change to settings and to data-folder files (like a tool rating in
 * ledger.md) is kept in history.sqlite with its exact before and after. Undo only puts a change
 * back when nothing has changed since; otherwise it says so and touches nothing.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { relative, isAbsolute } from 'node:path';
import { DEFAULT_SETTINGS, checkSettings, type AppSettings } from './settings.ts';

/** JSON with keys sorted, so the same settings always give the same text. */
export function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val,
  );
}

const PROVIDER_NAME: Record<string, string> = { claude: 'Claude', openai: 'OpenAI', deepseek: 'DeepSeek' };

/** "Monthly budget £20 → £30; Added rule “stripe”", or '' when nothing changed. */
export function describeSettingsChange(before: AppSettings, after: AppSettings): string {
  const parts: string[] = [];
  if (before.provider !== after.provider) {
    parts.push(`Provider ${PROVIDER_NAME[before.provider]} → ${PROVIDER_NAME[after.provider]}`);
  }
  if (before.monthlyBudgetGbp !== after.monthlyBudgetGbp) {
    parts.push(`Monthly budget £${before.monthlyBudgetGbp} → £${after.monthlyBudgetGbp}`);
  }
  if (before.runCapGbp !== after.runCapGbp) parts.push(`Build run limit £${before.runCapGbp} → £${after.runCapGbp}`);
  if (before.gbpPerUsd !== after.gbpPerUsd) parts.push(`£/$ rate ${before.gbpPerUsd} → ${after.gbpPerUsd}`);
  if (stable(before.models) !== stable(after.models)) parts.push('Model choices');
  if (stable(before.prices) !== stable(after.prices)) parts.push('Prices');
  if (before.dataFolder !== after.dataFolder) {
    parts.push(after.dataFolder ? `Data folder set to ${after.dataFolder}` : 'Data folder cleared');
  }
  for (const slug of new Set([...Object.keys(before.codeFolders), ...Object.keys(after.codeFolders)])) {
    const b = before.codeFolders[slug];
    const a = after.codeFolders[slug];
    if (a !== b) parts.push(a ? `Code folder for ${slug} set to ${a}` : `Code folder for ${slug} cleared`);
  }
  if (before.maintenance.patchUpdates !== after.maintenance.patchUpdates) {
    parts.push(`Dev-tool patch updates by the app ${after.maintenance.patchUpdates ? 'on' : 'off'}`);
  }
  const had = new Set(before.extraRules.map((r) => stable(r)));
  const has = new Set(after.extraRules.map((r) => stable(r)));
  for (const r of after.extraRules) if (!had.has(stable(r))) parts.push(`Added rule “${r.match}”`);
  for (const r of before.extraRules) if (!has.has(stable(r))) parts.push(`Removed rule “${r.match}”`);
  return parts.join('; ');
}

/** The label for undoing a change: undoing an undo is a redo, and the other way round. */
export function undoLabel(label: string): string {
  if (label.startsWith('Undo: ')) return `Redo: ${label.slice(6)}`;
  if (label.startsWith('Redo: ')) return `Undo: ${label.slice(6)}`;
  return `Undo: ${label}`;
}

/** "Undone: X." or "Redone: X." for the note shown after an undo. */
export function doneText(label: string): string {
  const next = undoLabel(label);
  return `${next.startsWith('Redo: ') ? 'Redone' : 'Undone'}: ${next.slice(6)}.`;
}

/** Settings as saved, or the defaults when the old file was missing or unreadable. */
function settingsOrDefault(raw: unknown): AppSettings {
  try {
    return checkSettings(raw);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

async function withLog<T>(dbPath: string, fn: (log: import('@aip/memory').ChangeLog) => T | Promise<T>): Promise<T> {
  const m = await import('@aip/memory');
  const log = m.ChangeLog.open(dbPath);
  try {
    return await fn(log);
  } finally {
    log.close();
  }
}

/**
 * Called after settings are saved. Records the change (if anything changed) and returns its id.
 * With `undoes`, the label says it was an undo and the earlier change is marked undone.
 */
export async function settingsSaved(
  dbPath: string,
  rawBefore: unknown,
  rawAfter: unknown,
  now: Date,
  undoes?: { id: number; label: string },
): Promise<number | null> {
  const before = settingsOrDefault(rawBefore);
  const after = checkSettings(rawAfter);
  const what = describeSettingsChange(before, after);
  if (!what && !undoes) return null;
  return withLog(dbPath, (log) =>
    log.record({
      at: now,
      kind: 'settings',
      label: undoes ? undoLabel(undoes.label) : what,
      target: '',
      before: stable(before),
      after: stable(after),
      undoes: undoes?.id,
    }),
  );
}

/** Records joshua's OK for something (like new packages in a build). There's nothing to put back. */
export async function approvalRecorded(dbPath: string, label: string, detail: string, now: Date) {
  return withLog(dbPath, (log) => log.record({ at: now, kind: 'approval', label, target: '', before: '', after: detail }));
}

/** Records that a kept build was reversed by a new commit (from → to). Nothing here can put it back. */
export async function revertRecorded(dbPath: string, label: string, folder: string, keptCommit: string, revertCommit: string, now: Date) {
  return withLog(dbPath, (log) => log.record({ at: now, kind: 'revert', label, target: folder, before: keptCommit, after: revertCommit }));
}

/** Records a change to a text file (e.g. ledger.md). */
export async function fileChanged(dbPath: string, path: string, before: string, after: string, label: string, now: Date) {
  if (before === after) return null;
  return withLog(dbPath, (log) => log.record({ at: now, kind: 'file', label, target: path, before, after }));
}

export interface HistoryItem {
  id: number;
  at: string;
  label: string;
  kind: 'settings' | 'file' | 'approval' | 'revert';
  /** When this change was undone, or null. */
  undoneAt: string | null;
  /** True when this change was itself an undo. */
  isUndo: boolean;
}

export async function historyList(dbPath: string, limit = 30): Promise<HistoryItem[]> {
  return withLog(dbPath, (log) =>
    log.list(limit).map((c) => ({ id: c.id, at: c.at, label: c.label, kind: c.kind, undoneAt: c.undoneAt, isUndo: c.undoes > 0 })),
  );
}

export type UndoStart =
  /** The Rust shell writes these settings, then calls settings_saved with `undoes`. */
  | { kind: 'settings'; id: number; label: string; settings: AppSettings; summary: string }
  /** A file change was put back here. */
  | { kind: 'file'; id: number; label: string; path: string; summary: string };

const CHANGED_SINCE = 'can’t be undone safely because it has changed since. Undo the newer changes first.';

/**
 * Undoes change `id`. Settings: checks the current settings still match, then hands back the
 * earlier ones for the shell to save. Files: checks the file still matches, then writes it back.
 */
export async function undoStart(dbPath: string, id: number, currentRawSettings: unknown, now: Date): Promise<UndoStart> {
  const change = await withLog(dbPath, (log) => log.get(id));
  if (!change) throw new Error('That change is no longer in the history.');
  if (change.undoneAt) throw new Error('That change has already been undone.');
  if (change.kind === 'approval') throw new Error('An approval can’t be undone here. Undo the build instead.');
  if (change.kind === 'revert') throw new Error('A reversed build can’t be undone here. Build the feature again if you want it back.');

  if (change.kind === 'settings') {
    if (stable(settingsOrDefault(currentRawSettings)) !== change.after) throw new Error(`Settings ${CHANGED_SINCE}`);
    return { kind: 'settings', id, label: change.label, settings: checkSettings(JSON.parse(change.before)), summary: doneText(change.label) };
  }

  let current: string;
  try {
    current = await readFile(change.target, 'utf8');
  } catch {
    throw new Error(`Can’t undo: ${change.target} can’t be read.`);
  }
  if (current !== change.after) throw new Error(`This file ${CHANGED_SINCE}`);
  const temp = `${change.target}.undo-${process.pid}`;
  await writeFile(temp, change.before);
  await rename(temp, change.target);
  await withLog(dbPath, (log) =>
    log.record({ at: now, kind: 'file', label: undoLabel(change.label), target: change.target, before: change.after, after: change.before, undoes: id }),
  );
  return { kind: 'file', id, label: change.label, path: change.target, summary: doneText(change.label) };
}

/**
 * CI-8: checks an undo really worked: the settings (as read back after saving) or the file now
 * match what they were before change `id`. Changes nothing.
 */
export async function undoCheck(dbPath: string, id: number, currentRawSettings: unknown): Promise<{ ok: boolean; text: string }> {
  const change = await withLog(dbPath, (log) => log.get(id));
  if (!change) throw new Error('That change is no longer in the history.');
  if (change.kind === 'settings') {
    let now = '';
    try {
      now = stable(checkSettings(currentRawSettings));
    } catch {
      // unreadable settings never match
    }
    return now === change.before
      ? { ok: true, text: 'Checked: Settings are back as they were.' }
      : { ok: false, text: 'Check failed: Settings don’t match what they were before. Open Settings and look before building.' };
  }
  let current: string | null = null;
  try {
    current = await readFile(change.target, 'utf8');
  } catch {
    // missing file: doesn't match
  }
  return current === change.before
    ? { ok: true, text: 'Checked: the file is back as it was.' }
    : { ok: false, text: `Check failed: ${change.target} doesn’t match what it was before.` };
}

/** True when `path` is inside `folder`. */
export function isInside(folder: string, path: string): boolean {
  if (!folder) return false;
  const rel = relative(folder, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

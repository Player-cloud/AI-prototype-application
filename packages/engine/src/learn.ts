/**
 * Step 9d: after each Keep, Undo or rating, the app looks at the evidence and updates its own
 * section of habits.md. Only with enough evidence (see @aip/memory learnHabits). Every change is
 * kept in the history (one-click undo), synced to the data repo, and joshua is told in plain words.
 */
import { join } from 'node:path';
import type { AppSettings } from './settings.ts';
import { fileChanged } from './history.ts';

export type NameOf = (model: string) => Promise<string>;

/** Plain-words notes for joshua; empty when nothing changed or there's no data folder. */
export async function learnNow(settings: AppSettings, dbPath: string, nameOf: NameOf, now: Date): Promise<string[]> {
  if (!settings.dataFolder) return [];
  const m = await import('@aip/memory');
  const { readFile, writeFile, rename } = await import('node:fs/promises');
  const log = m.RunLog.open(dbPath);
  let runs: import('@aip/memory').Run[];
  try {
    runs = log.list(undefined, 100);
  } finally {
    log.close();
  }
  const names = new Map<string, string>();
  for (const r of runs) if (!names.has(r.model)) names.set(r.model, await nameOf(r.model));
  const learned = m.learnHabits(runs, (id) => names.get(id) ?? id);

  const path = join(settings.dataFolder, 'habits.md');
  let before = '';
  try {
    before = await readFile(path, 'utf8');
  } catch {
    before = '# Habits\n';
  }
  const ch = m.applyLearned(before, learned);
  if (ch.md === before) return [];
  const tmp = `${path}.tmp`;
  await writeFile(tmp, ch.md, 'utf8');
  await rename(tmp, path);
  const notes = [
    ...ch.added.map((h) => `New habit: ${h}`),
    ...ch.changed.map((h) => `Habit updated: ${h}`),
    ...ch.dropped.map((h) => `Habit dropped (no longer true): ${h}`),
  ];
  const label = `Learned habits: ${[ch.added.length && `${ch.added.length} new`, ch.changed.length && `${ch.changed.length} updated`, ch.dropped.length && `${ch.dropped.length} dropped`].filter(Boolean).join(', ')}`;
  await fileChanged(dbPath, path, before, ch.md, label, now);
  try {
    await m.syncDataRepo(settings.dataFolder, label);
  } catch (err) {
    notes.push(`Saved here, but not synced yet: ${(err as Error).message}`);
  }
  return notes;
}

/** joshua's rules and habits for the build prompt. Rules win while more than 30% of the budget is left (D-2). */
export async function guidance(settings: AppSettings, rulesWin: boolean): Promise<string> {
  if (!settings.dataFolder) return '';
  const m = await import('@aip/memory');
  const { readFile } = await import('node:fs/promises');
  const read = (f: string) => readFile(join(settings.dataFolder, f), 'utf8').catch(() => '');
  const rules = m.bullets(await read('rules.md'));
  const habits = m.bullets(await read('habits.md'));
  if (!rules.length && !habits.length) return '';
  return [
    '',
    rulesWin ? 'The user’s rules come first; follow their habits where they don’t clash.' : 'Under 30% of this month’s budget is left: where a rule and a cheaper habit clash, follow the habit.',
    ...(rules.length ? ['Rules:', ...rules.map((r) => `- ${r}`)] : []),
    ...(habits.length ? ['Habits:', ...habits.map((h) => `- ${h}`)] : []),
  ].join('\n');
}

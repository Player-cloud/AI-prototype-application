/**
 * Stage R3: a new data folder without a terminal and without GitHub. Makes a git folder on branch
 * main with the starter ledger, rules, habits and tool cards (packages/engine/starter-data), sets
 * the commit name and email from Settings for that folder only, and makes one first commit.
 * Only an empty or missing folder is used; anything else is left alone. Nothing is pushed: with no
 * remote, saving stays on this computer (Local only) until a GitHub remote is added.
 */
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AppSettings } from './settings.ts';
import { identityOf, isIdentityError, NO_IDENTITY, setIdentity, type Git } from './runs.ts';

/** The starter files, shipped with the engine (also inside the installed app's engine folder). */
export const STARTER_DIR = fileURLToPath(new URL('../starter-data/', import.meta.url));

export interface CreatedDataFolder { folder: string; summary: string }

export async function createDataFolder(settings: AppSettings, folder: string, git?: Git, starter = STARTER_DIR): Promise<CreatedDataFolder> {
  const g = git ?? (await import('@aip/memory')).realGit;
  const path = folder.trim();
  if (!path) throw new Error('Type the folder path first.');
  const identity = identityOf(settings);
  if (!identity) throw new Error('Enter “Your name” and “Your email” in Settings and save them first: every change in the data folder is saved with them.');
  let entries: string[] = [];
  try {
    const s = await stat(path);
    if (!s.isDirectory()) throw new Error(`${path} is a file, not a folder.`);
    entries = await readdir(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (entries.length) throw new Error(`${path} isn’t empty, so nothing was changed. Pick a new folder, or an existing data folder and press Save.`);
  await mkdir(path, { recursive: true });
  await g(['init', '-q', '-b', 'main'], path);
  await setIdentity(path, identity, g);
  await cp(starter, path, { recursive: true });
  await mkdir(`${path}/projects`, { recursive: true });
  await g(['add', '-A'], path);
  try {
    await g(['commit', '-q', '-m', 'Start data folder'], path);
  } catch (err) {
    const msg = (err as Error).message;
    throw new Error(isIdentityError(msg) ? NO_IDENTITY : `Couldn’t make the first commit: ${msg.split('\n')[0]}`);
  }
  return { folder: path, summary: `Made a new data folder at ${path}, saved on this computer only (GitHub sync is off). Press Save to use it.` };
}

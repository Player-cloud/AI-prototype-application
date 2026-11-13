/**
 * CI-7 (SUP-H): each project's approved tools and its own rules, kept in projects/<slug>/.
 *  - tools.md: one "- <tool id>" line per approved tool. No file means nothing has been chosen
 *    yet, so the project uses the general tools as before.
 *  - rules.md: "- " lines that apply to this project only. They beat the general rules and
 *    habits for this project, and never reach another project.
 * Only joshua's choice in the app writes tools.md; the app suggests, it doesn't approve.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bullets } from './data-repo.js';
import { SLUG, writeProjectFiles } from './projects.js';

/** Tool IDs: the card file name or the name as a slug. */
export const TOOL_ID = /^(?=.{1,80}$)[a-z0-9]+(?:[-.][a-z0-9]+)*$/;

function dirOf(folder: string, slug: string): string {
  if (!SLUG.test(slug)) throw new Error(`“${slug}” isn’t a valid project folder name.`);
  return join(folder, 'projects', slug);
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * The approved tool IDs, or null when none have been chosen for this project yet (no file, or an
 * empty one, which is what undoing the first choice leaves behind).
 */
export async function readProjectTools(folder: string, slug: string): Promise<string[] | null> {
  const md = await readOrNull(join(dirOf(folder, slug), 'tools.md'));
  if (md === null || md.trim() === '') return null;
  return [...new Set(bullets(md).filter((id) => TOOL_ID.test(id)))];
}

/** The tools.md text for a set of approved tool IDs (sorted, no repeats). */
export function projectToolsText(slug: string, ids: string[]): string {
  const bad = ids.filter((id) => !TOOL_ID.test(id));
  if (bad.length) throw new Error(`Not a tool ID: ${bad.join(', ')}`);
  const sorted = [...new Set(ids)].sort();
  return [`# Approved tools for ${slug}`, '', 'Chosen in the app. Builds for this project use only these.', '', ...sorted.map((id) => `- ${id}`), ''].join('\n');
}

/** Saves the approved tool IDs. Returns the written path (relative to the data folder). */
export async function writeProjectTools(folder: string, slug: string, ids: string[]): Promise<string> {
  const [path] = await writeProjectFiles(folder, slug, { 'tools.md': projectToolsText(slug, ids) });
  return path!;
}

/** This project's own rules ("- " lines in projects/<slug>/rules.md). */
export async function readProjectRules(folder: string, slug: string): Promise<string[]> {
  const md = await readOrNull(join(dirOf(folder, slug), 'rules.md'));
  return md === null ? [] : bullets(md);
}

/**
 * Project plans in the private data repo: projects/<slug>/ holds interview.json (the plan
 * interview so far), spec.md and done/<feature id>.md once the interview is finished.
 * Only files inside a project's own folder can be written.
 */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';

/** Project folder names: lower case letters, digits and dashes, 1–40 characters. */
export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** "Club HR!" -> "club-hr". '' when nothing usable is left. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

function projectDir(folder: string, slug: string): string {
  if (!SLUG.test(slug)) throw new Error(`“${slug}” isn’t a valid project folder name.`);
  return join(folder, 'projects', slug);
}

/** Folders under projects/ that have an interview.json, sorted. */
export async function listProjectSlugs(folder: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(folder, 'projects'));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names.sort()) {
    if (!SLUG.test(n)) continue;
    try {
      await readFile(join(folder, 'projects', n, 'interview.json'), 'utf8');
      out.push(n);
    } catch {
      // not a planned project (or not one of ours)
    }
  }
  return out;
}

/** The project's interview.json, parsed, or null if there isn't one. */
export async function readProjectJson(folder: string, slug: string): Promise<unknown> {
  const dir = projectDir(folder, slug);
  try {
    return JSON.parse(await readFile(join(dir, 'interview.json'), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`projects/${slug}/interview.json can’t be read: ${(err as Error).message}`);
  }
}

/**
 * Writes files inside projects/<slug>/ (paths relative to it, e.g. "spec.md", "done/F-01.md").
 * Each file is written to a temp file then renamed, so a crash never leaves half a file.
 */
export async function writeProjectFiles(folder: string, slug: string, files: Record<string, string>): Promise<string[]> {
  const dir = projectDir(folder, slug);
  const written: string[] = [];
  for (const [rel, text] of Object.entries(files)) {
    const path = join(dir, rel);
    const inside = relative(dir, path);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`Refused to write outside the project: ${rel}`);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.tmp-${process.pid}`;
    await writeFile(temp, text);
    await rename(temp, path);
    written.push(`projects/${slug}/${inside.split('\\').join('/')}`);
  }
  return written;
}

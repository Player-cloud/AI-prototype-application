/**
 * Project map: feature -> files -> tests, per project, kept in the data folder at
 * projects/<slug>/map.json. Refreshed after each Keep and shown before a build.
 *
 * Paths are always relative to the project's repo with forward slashes, on every computer. Absolute
 * paths, paths that climb out of the project and key files (.env, *.pem, ...) are never stored.
 * Writing the map is best-effort: a map problem never fails a Keep.
 *
 * Undo: only a build that is still waiting can be undone, and it never reached the map, so there
 * is nothing to take out. Files of a kept build leave the map when they leave the project, and
 * when a kept build is reversed its feature loses the files the reversal changed.
 */
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppSettings } from './settings.ts';

export const MAP_VERSION = 1;
/** Files kept per feature; past this the oldest are dropped, with a note. */
export const MAX_FILES = 200;
/** Paths added to a build prompt as a hint. */
export const HINT_MAX = 30;

export interface FeatureEntry {
  title: string;
  files: string[];
  tests: string[];
  lastBuildId: number;
  lastKeptAt: string;
  /** IDs (DEC-n) of the decisions that name this feature. Missing in older maps: read as none. */
  decisions?: string[];
  /** IDs (BLK-n) of the blockers, open or closed, that name this feature. Missing in older maps: read as none. */
  blockers?: string[];
  /** Set when the file list was cut to the cap. */
  note?: string;
}
export interface ProjectMap { version: 1; updatedAt: string | null; features: Record<string, FeatureEntry> }

export const emptyMap = (): ProjectMap => ({ version: MAP_VERSION, updatedAt: null, features: {} });

/** Test files: *.test.*, *.spec.*, or anything inside a tests/ or __tests__/ folder. */
export function isTestPath(path: string): boolean {
  return /\.(test|spec)\.[^/]+$/i.test(path) || /(^|\/)(tests?|__tests__)\//i.test(path);
}

/** Repo-relative, forward slashes, or null when the path must not be stored. */
export async function cleanPath(raw: string): Promise<string | null> {
  const p = raw.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (!p || p.startsWith('/') || /^[a-z]:/i.test(p) || p.includes('\0')) return null;
  const parts = p.split('/');
  if (parts.some((s) => s === '..' || s === '' || s === '.' || /^\.git$/i.test(s))) return null;
  const { KEY_FILE } = await import('@aip/checks');
  if (KEY_FILE.test(parts[parts.length - 1]!) && !/\.example$/i.test(p)) return null;
  return p;
}

async function mapFile(settings: AppSettings, slug: string): Promise<string> {
  if (!settings.dataFolder) throw new Error('Set your data folder in Settings first.');
  const { SLUG } = await import('@aip/memory');
  if (!SLUG.test(slug)) throw new Error(`“${slug}” isn’t a valid project folder name.`);
  return join(settings.dataFolder, 'projects', slug, 'map.json');
}

/** The saved map, or an empty one when there is none (or it can't be read). */
export async function readMap(settings: AppSettings, slug: string): Promise<ProjectMap> {
  const file = await mapFile(settings, slug);
  try {
    const m = JSON.parse(await readFile(file, 'utf8')) as ProjectMap;
    if (m && m.version === MAP_VERSION && m.features && typeof m.features === 'object') return m;
  } catch {
    // no map yet, or not readable: start empty
  }
  return emptyMap();
}

/**
 * Adds one kept build's changed files to its feature and drops files that are gone from the
 * project. `exists` says whether a repo-relative path is still in the project.
 */
export async function refreshMap(
  map: ProjectMap,
  build: { feature: string; title: string; buildId: number; keptAt: string; changed: string[] },
  exists: (path: string) => Promise<boolean>,
): Promise<ProjectMap> {
  const features: Record<string, FeatureEntry> = {};
  for (const [id, e] of Object.entries(map.features)) {
    const files: string[] = [];
    for (const f of e.files) if (await exists(f)) files.push(f);
    features[id] = { ...e, files, tests: files.filter(isTestPath) };
  }
  const wanted = new Set(features[build.feature]?.files ?? []);
  for (const raw of build.changed) {
    const p = await cleanPath(raw);
    if (p && (await exists(p))) wanted.add(p);
  }
  let files = [...wanted];
  let note: string | undefined;
  if (files.length > MAX_FILES) {
    note = `Only the newest ${MAX_FILES} files are listed (${files.length - MAX_FILES} older ones left out).`;
    files = files.slice(files.length - MAX_FILES);
  }
  features[build.feature] = { title: build.title, files, tests: files.filter(isTestPath), lastBuildId: build.buildId, lastKeptAt: build.keptAt, ...(note ? { note } : {}) };
  return { version: MAP_VERSION, updatedAt: build.keptAt, features };
}

/** The map with each feature's decision and blocker IDs taken from decisions.json. Only features already in the map are touched. */
export function attachDecisions(map: ProjectMap, d: { decisions: { id: string; feature?: string }[]; blockers: { id: string; feature?: string }[] }): ProjectMap {
  const features: Record<string, FeatureEntry> = {};
  for (const [id, e] of Object.entries(map.features)) {
    features[id] = { ...e, decisions: d.decisions.filter((x) => x.feature === id).map((x) => x.id), blockers: d.blockers.filter((x) => x.feature === id).map((x) => x.id) };
  }
  return { ...map, features };
}

/**
 * When decisions or blockers change: refresh the IDs in the map. Does nothing when the project has
 * no map yet, and writes only when something changed. Never throws (a map problem must not fail a decision).
 */
export async function updateMapDecisions(settings: AppSettings, slug: string): Promise<void> {
  try {
    const map = await readMap(settings, slug);
    if (Object.keys(map.features).length === 0) return;
    const { readDecisions } = await import('./decisions.ts');
    const next = attachDecisions(map, await readDecisions(settings, slug));
    if (JSON.stringify(next) !== JSON.stringify(map)) await writeMap(settings, slug, next);
  } catch {
    // best-effort
  }
}

export async function writeMap(settings: AppSettings, slug: string, map: ProjectMap): Promise<void> {
  const file = await mapFile(settings, slug);
  await mkdir(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/**
 * After a Keep: refresh the map from the build's changed files. Returns a plain note for the
 * Keep result ('' when nothing needs saying). Never throws.
 */
export async function updateMapAfterKeep(
  settings: AppSettings,
  slug: string,
  build: { feature: string; buildId: number; keptAt: Date; changed: string[] },
  codeFolder: string,
): Promise<string> {
  if (!settings.dataFolder) return '';
  try {
    let title = build.feature;
    try {
      const { getInterview } = await import('./projects.ts');
      title = (await getInterview(settings, slug)).interview.features.find((f) => f.id === build.feature)?.name ?? title;
    } catch {
      // no plan to read the name from: the feature ID will do
    }
    const exists = (p: string) => lstat(join(codeFolder, ...p.split('/'))).then(() => true, () => false);
    const next = await refreshMap(await readMap(settings, slug), { feature: build.feature, title, buildId: build.buildId, keptAt: build.keptAt.toISOString(), changed: build.changed }, exists);
    let withDecisions = next;
    try {
      const { readDecisions } = await import('./decisions.ts');
      withDecisions = attachDecisions(next, await readDecisions(settings, slug));
    } catch {
      // the decisions file is a nice-to-have here: keep the map as refreshed
    }
    await writeMap(settings, slug, withDecisions);
    return '';
  } catch (err) {
    return ` The project map wasn’t updated (${(err as Error).message.split('\n')[0]}).`;
  }
}

/**
 * After a kept build is reversed: its feature loses the files the revert changed, files gone from
 * the project leave every feature, and a feature left with no files is dropped. Never throws;
 * returns a plain note ('' when nothing needs saying).
 */
export async function updateMapAfterRevert(settings: AppSettings, slug: string, build: { feature: string; changed: string[]; at: Date }, codeFolder: string): Promise<string> {
  if (!settings.dataFolder) return '';
  try {
    const map = await readMap(settings, slug);
    const exists = (p: string) => lstat(join(codeFolder, ...p.split('/'))).then(() => true, () => false);
    const changed = new Set<string>();
    for (const raw of build.changed) {
      const c = await cleanPath(raw);
      if (c) changed.add(c);
    }
    const features: Record<string, FeatureEntry> = {};
    for (const [id, e] of Object.entries(map.features)) {
      const files: string[] = [];
      for (const f of e.files) if ((id !== build.feature || !changed.has(f)) && (await exists(f))) files.push(f);
      if (files.length || id !== build.feature) features[id] = { ...e, files, tests: files.filter(isTestPath) };
    }
    await writeMap(settings, slug, { version: MAP_VERSION, updatedAt: build.at.toISOString(), features });
    return '';
  } catch (err) {
    return ` The project map wasn’t updated (${(err as Error).message.split('\n')[0]}).`;
  }
}

/** A short hint for a build prompt: what this feature touched before ('' for a new feature). */
export function mapHint(entry: FeatureEntry | undefined): string {
  if (!entry || !entry.files.length) return '';
  const shown = entry.files.slice(0, HINT_MAX);
  const more = entry.files.length - shown.length;
  return ['', 'Files this feature touched in earlier builds (a hint, not a limit):', ...shown.map((f) => `- ${f}`), ...(more > 0 ? [`- …and ${more} more`] : [])].join('\n');
}

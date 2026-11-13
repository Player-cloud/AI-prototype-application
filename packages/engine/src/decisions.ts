/**
 * Decisions and blockers: a small record per project in the data folder, projects/<slug>/decisions.json.
 * Decisions joshua made (builds are told to follow them) and things blocking progress (the Build
 * screen shows an open blocker before a build and asks "are you sure?"; the engine still allows it).
 *
 * Append-only: a decision is never edited or deleted (a later one can say it replaces DEC-3 in its
 * text). A blocker can only be closed, with an optional note. Text is plain, capped, and refused if
 * it looks like a key. Every change goes into the change history with a plain label. The file is
 * picked up by the next data sync.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileChanged } from './history.ts';
import { updateMapDecisions } from './project-map.ts';
import type { AppSettings } from './settings.ts';

export const DECISIONS_VERSION = 1;
/** Longest text (characters) for a decision, its reason, a blocker or a closing note. */
export const MAX_TEXT = 500;
/** Most records of each kind kept in the file. */
export const MAX_RECORDS = 500;
/** Decisions put in a build prompt: the newest ones. */
export const PROMPT_DECISIONS = 10;
/** Longest a decision is in a build prompt. */
export const PROMPT_CHARS = 200;

export interface Decision { id: string; date: string; text: string; why?: string; feature?: string }
export interface Blocker { id: string; date: string; text: string; feature?: string; open: boolean; closedAt?: string; closedNote?: string }
export interface DecisionsFile { version: 1; decisions: Decision[]; blockers: Blocker[] }

export const emptyDecisions = (): DecisionsFile => ({ version: DECISIONS_VERSION, decisions: [], blockers: [] });

const KEY_PREFIX = /\b(sk-|ghp_|gho_|ghs_|github_pat_|xox[abp]-|AKIA[0-9A-Z]{8,}|AIza[0-9A-Za-z_-]{20,})/;
const FEATURE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/;

/** True for text that looks like a key: a known key shape or prefix, or a long unbroken token mixing letters and digits. */
export function looksSecret(text: string, looksLikeKey: (t: string) => boolean): boolean {
  if (looksLikeKey(text) || KEY_PREFIX.test(text) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return true;
  return (text.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? []).some((t) => /[A-Za-z]/.test(t) && /\d/.test(t));
}

async function filePath(settings: AppSettings, slug: string): Promise<string> {
  if (!settings.dataFolder) throw new Error('Set your data folder in Settings first.');
  const { SLUG } = await import('@aip/memory');
  if (typeof slug !== 'string' || !SLUG.test(slug)) throw new Error(`“${String(slug)}” isn’t a valid project folder name.`);
  return join(settings.dataFolder, 'projects', slug, 'decisions.json');
}

/** The saved record, or an empty one when there is none (or it can't be read). */
export async function readDecisions(settings: AppSettings, slug: string): Promise<DecisionsFile> {
  const file = await filePath(settings, slug);
  try {
    const d = JSON.parse(await readFile(file, 'utf8')) as DecisionsFile;
    if (d && d.version === DECISIONS_VERSION && Array.isArray(d.decisions) && Array.isArray(d.blockers)) return d;
  } catch {
    // none yet, or not readable: start empty
  }
  return emptyDecisions();
}

async function cleanText(raw: unknown, what: string, required: boolean): Promise<string | undefined> {
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new Error(`Write what the ${what} is.`);
    return undefined;
  }
  if (typeof raw !== 'string') throw new Error(`The ${what} must be text.`);
  const text = raw.trim().replace(/\s+/g, ' ');
  if (!text) {
    if (required) throw new Error(`Write what the ${what} is.`);
    return undefined;
  }
  if (text.length > MAX_TEXT) throw new Error(`The ${what} is too long (${text.length} characters; the most is ${MAX_TEXT}). Shorten it.`);
  const { looksLikeKey } = await import('@aip/memory');
  if (looksSecret(text, looksLikeKey)) {
    throw new Error(`The ${what} looks like it has a key or password in it. Keys never go in the project record (it syncs to GitHub). Take it out and try again; keys live only in Settings.`);
  }
  return text;
}

function cleanFeature(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || !FEATURE.test(raw.trim())) throw new Error('The feature must be an ID like F-01.');
  return raw.trim();
}

const nextId = (prefix: string, ids: string[]) => `${prefix}-${Math.max(0, ...ids.map((i) => Number(i.slice(prefix.length + 1)) || 0)) + 1}`;

async function save(settings: AppSettings, slug: string, next: DecisionsFile, label: string, dbPath: string | null, now: Date): Promise<void> {
  const file = await filePath(settings, slug);
  const before = await readFile(file, 'utf8').catch(() => '');
  await mkdir(join(file, '..'), { recursive: true });
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
  if (dbPath) await fileChanged(dbPath, file, before, text, label, now);
  await updateMapDecisions(settings, slug); // the project map lists these IDs per feature
}

async function mustExist(settings: AppSettings, slug: string): Promise<void> {
  const { getInterview } = await import('./projects.ts');
  await getInterview(settings, slug);
}

export async function addDecision(settings: AppSettings, slug: string, p: { text: unknown; why?: unknown; feature?: unknown }, dbPath: string | null, now: Date): Promise<{ decision: Decision; summary: string } & DecisionsFile> {
  await filePath(settings, slug);
  const text = (await cleanText(p.text, 'decision', true))!;
  const why = await cleanText(p.why, 'reason', false);
  const feature = cleanFeature(p.feature);
  await mustExist(settings, slug);
  const cur = await readDecisions(settings, slug);
  if (cur.decisions.length >= MAX_RECORDS) throw new Error(`This project already has ${MAX_RECORDS} decisions, the most it keeps.`);
  const decision: Decision = { id: nextId('DEC', cur.decisions.map((d) => d.id)), date: now.toISOString().slice(0, 10), text, ...(why ? { why } : {}), ...(feature ? { feature } : {}) };
  const next = { ...cur, decisions: [...cur.decisions, decision] };
  await save(settings, slug, next, `Decision ${decision.id} for ${slug}: ${text.length > 60 ? `${text.slice(0, 57)}…` : text}`, dbPath, now);
  return { ...next, decision, summary: `Saved ${decision.id}. Builds for ${slug} are told to follow it.` };
}

export async function addBlocker(settings: AppSettings, slug: string, p: { text: unknown; feature?: unknown }, dbPath: string | null, now: Date): Promise<{ blocker: Blocker; summary: string } & DecisionsFile> {
  await filePath(settings, slug);
  const text = (await cleanText(p.text, 'blocker', true))!;
  const feature = cleanFeature(p.feature);
  await mustExist(settings, slug);
  const cur = await readDecisions(settings, slug);
  if (cur.blockers.length >= MAX_RECORDS) throw new Error(`This project already has ${MAX_RECORDS} blockers, the most it keeps.`);
  const blocker: Blocker = { id: nextId('BLK', cur.blockers.map((b) => b.id)), date: now.toISOString().slice(0, 10), text, ...(feature ? { feature } : {}), open: true };
  const next = { ...cur, blockers: [...cur.blockers, blocker] };
  await save(settings, slug, next, `Blocker ${blocker.id} for ${slug}: ${text.length > 60 ? `${text.slice(0, 57)}…` : text}`, dbPath, now);
  return { ...next, blocker, summary: `Added ${blocker.id}.${feature ? ` ${feature} will ask before it builds.` : ''}` };
}

export async function closeBlocker(settings: AppSettings, slug: string, p: { id: unknown; note?: unknown }, dbPath: string | null, now: Date): Promise<{ blocker: Blocker; summary: string } & DecisionsFile> {
  await filePath(settings, slug);
  const note = await cleanText(p.note, 'note', false);
  const cur = await readDecisions(settings, slug);
  const found = cur.blockers.find((b) => b.id === p.id);
  if (!found) throw new Error(`There’s no blocker ${String(p.id)} in ${slug}.`);
  if (!found.open) throw new Error(`${found.id} is already closed.`);
  const blocker: Blocker = { ...found, open: false, closedAt: now.toISOString().slice(0, 10), ...(note ? { closedNote: note } : {}) };
  const next = { ...cur, blockers: cur.blockers.map((b) => (b.id === blocker.id ? blocker : b)) };
  await save(settings, slug, next, `Closed blocker ${blocker.id} for ${slug}`, dbPath, now);
  return { ...next, blocker, summary: `Closed ${blocker.id}.` };
}

/** Open blockers that stop a feature: its own, and ones that name no feature. */
export function openBlockersFor(d: DecisionsFile, feature: string): Blocker[] {
  return d.blockers.filter((b) => b.open && (!b.feature || b.feature === feature));
}

/** For a build prompt: the newest decisions, short ('' when there are none). */
export function decisionsHint(d: DecisionsFile): string {
  if (!d.decisions.length) return '';
  const short = (t: string) => (t.length > PROMPT_CHARS ? `${t.slice(0, PROMPT_CHARS - 1)}…` : t);
  const shown = d.decisions.slice(-PROMPT_DECISIONS);
  return ['', 'Decisions the user made — follow them:', ...shown.map((x) => `- ${x.id}${x.feature ? ` (${x.feature})` : ''}: ${short(x.text)}${x.why ? ` Why: ${short(x.why)}` : ''}`)].join('\n');
}

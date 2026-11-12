/**
 * CI-6: updates the app has spotted, and joshua's decision on each, kept in the data repo as
 * updates.json. Found, OK'd, declined and installed are separate states: an update found is
 * never an update installed, and the app never installs one. memory keeps the records.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { looksLikeKey } from './sync.js';

export type UpdateStatus = 'found' | 'approved' | 'declined' | 'installed';

export interface UpdateRecord {
  package: string;
  from: string;
  to: string;
  level: string;
  capability: string;
  usedBy: string[];
  deprecated: boolean;
  status: UpdateStatus;
  foundAt: string;
  foundOn: string;
  decidedAt: string | null;
}

const FILE = 'updates.json';
/** Decided or installed records kept; open ones are never dropped. */
export const KEEP_UPDATES = 200;

export async function readUpdates(folder: string): Promise<UpdateRecord[]> {
  try {
    const raw = JSON.parse(await readFile(join(folder, FILE), 'utf8')) as { updates?: unknown };
    return Array.isArray(raw.updates) ? (raw.updates as UpdateRecord[]).filter((u) => typeof u?.package === 'string' && typeof u?.to === 'string' && typeof u?.status === 'string') : [];
  } catch {
    return [];
  }
}

export async function writeUpdates(folder: string, updates: UpdateRecord[]): Promise<void> {
  const text = `${JSON.stringify({ updates }, null, 2)}\n`;
  if (looksLikeKey(text)) throw new Error('The update list looked like it held a key, so it wasn’t saved.');
  const path = join(folder, FILE);
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, text);
  await rename(temp, path);
}

export interface Found { package: string; current: string; latest: string; level: string; capability: string; usedBy: string[]; deprecated: boolean }

/**
 * Adds what a look-up found. A version already on record keeps its decision. When the installed
 * version has reached an OK'd or found version, that record becomes "installed".
 */
export function mergeUpdates(existing: UpdateRecord[], found: Found[], installed: Record<string, string>, now: Date, computer: string): UpdateRecord[] {
  const out = existing.map((u) => (u.status !== 'installed' && installed[u.package] === u.to ? { ...u, status: 'installed' as const, decidedAt: u.decidedAt ?? now.toISOString() } : u));
  for (const f of found) {
    if (out.some((u) => u.package === f.package && u.to === f.latest)) continue;
    out.push({ package: f.package, from: f.current, to: f.latest, level: f.level, capability: f.capability, usedBy: f.usedBy, deprecated: f.deprecated, status: 'found', foundAt: now.toISOString(), foundOn: computer, decidedAt: null });
  }
  const open = out.filter((u) => u.status === 'found' || u.status === 'approved');
  const done = out.filter((u) => u.status === 'declined' || u.status === 'installed').slice(-KEEP_UPDATES);
  return [...open, ...done];
}

/** joshua's OK or no for one version. Only an open record can be decided. */
export function decideUpdate(updates: UpdateRecord[], pkg: string, to: string, ok: boolean, now: Date): UpdateRecord[] {
  const i = updates.findIndex((u) => u.package === pkg && u.to === to);
  if (i < 0) throw new Error(`There’s no update of ${pkg} to ${to} on record.`);
  if (updates[i]!.status === 'installed') throw new Error(`${pkg} ${to} is already installed.`);
  return updates.map((u, j) => (j === i ? { ...u, status: ok ? 'approved' : 'declined', decidedAt: now.toISOString() } : u));
}

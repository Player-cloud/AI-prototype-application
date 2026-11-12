/**
 * Tool health, kept in the data repo so both computers see it: one small file per tool,
 * tool-health/<slug>.json (one file each, so the two computers rarely clash when syncing).
 *
 * D-2: memory keeps the records (versions, failures, stale evidence, retests). The engine
 * decides what to do with them (e.g. switching a tool off after 3 failures in a row, step 8).
 * Switching a tool off never uninstalls it.
 */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { slugify } from './projects.js';
import { looksLikeKey } from './sync.js';

export interface ToolFailure { at: string; error: string }

export interface ToolHealth {
  /** CI-1: the tool's stable ID (its card's file name, or its name as a slug); names the file. */
  id: string;
  /** The tool's name as in ledger.md. */
  tool: string;
  /** The version last seen, or null if never seen. */
  version: string | null;
  /** The version the test evidence is for. */
  testedVersion: string | null;
  /** True when the tool has changed since its evidence was gathered. */
  stale: boolean;
  /** Run a quick retest the next time the tool is used. */
  retestDue: boolean;
  consecutiveFailures: number;
  /** The newest failures, oldest first. */
  failures: ToolFailure[];
  lastOk: string | null;
  lastRetest: { at: string; ok: boolean } | null;
  /** Set when the tool was switched off (not uninstalled), with why. */
  off: { at: string; reason: string } | null;
}

/** Failures kept per tool. */
export const KEEP_FAILURES = 20;
const MAX_ERROR_CHARS = 300;

export function emptyHealth(tool: string, id = slugify(tool)): ToolHealth {
  return { id, tool, version: null, testedVersion: null, stale: false, retestDue: false, consecutiveFailures: 0, failures: [], lastOk: null, lastRetest: null, off: null };
}

/**
 * Notes the version in use. The first version seen becomes the baseline. A different version
 * later marks the evidence stale and schedules a retest on the next use.
 */
export function noteVersion(h: ToolHealth, version: string): ToolHealth {
  const v = version.trim();
  if (!v || v === h.version) return h;
  if (h.testedVersion === null) return { ...h, version: v, testedVersion: v };
  if (v === h.testedVersion) return { ...h, version: v, stale: false, retestDue: false };
  return { ...h, version: v, stale: true, retestDue: true };
}

function cleanError(error: string): string {
  const one = error.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_CHARS) || 'Failed (no message).';
  return looksLikeKey(one) ? 'Failed (the message looked like it held a key, so it wasn’t kept).' : one;
}

/**
 * Records one use of the tool. A success resets the failure count; if a retest was due, it
 * also clears the stale mark. A failure adds to the count and the failure list.
 */
export function recordRun(h: ToolHealth, run: { ok: boolean; error?: string }, now: Date): ToolHealth {
  const at = now.toISOString();
  const lastRetest = h.retestDue ? { at, ok: run.ok } : h.lastRetest;
  if (run.ok) {
    return {
      ...h,
      consecutiveFailures: 0,
      lastOk: at,
      lastRetest,
      ...(h.retestDue ? { stale: false, retestDue: false, testedVersion: h.version } : {}),
    };
  }
  const failures = [...h.failures, { at, error: cleanError(run.error ?? '') }].slice(-KEEP_FAILURES);
  return { ...h, consecutiveFailures: h.consecutiveFailures + 1, failures, lastRetest };
}

/** Switches the tool off (it stays installed). */
export function switchOff(h: ToolHealth, reason: string, now: Date): ToolHealth {
  return { ...h, off: { at: now.toISOString(), reason } };
}

/** Switches it back on with a clean failure count; a retest runs on its next use. */
export function switchOn(h: ToolHealth): ToolHealth {
  return { ...h, off: null, consecutiveFailures: 0, retestDue: true };
}

function healthPath(folder: string, id: string): string {
  if (!id || slugify(id) !== id) throw new Error(`“${id}” can’t be used as a tool ID.`);
  return join(folder, 'tool-health', `${id}.json`);
}

/** Checks a parsed file, filling gaps, so a damaged file never stops the app. */
export function checkHealth(raw: unknown, tool: string, id = slugify(tool)): ToolHealth {
  const base = emptyHealth(tool, id);
  if (typeof raw !== 'object' || raw === null) return base;
  const r = raw as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : null);
  const failures = Array.isArray(r.failures)
    ? r.failures
        .filter((f): f is ToolFailure => typeof f === 'object' && f !== null && typeof (f as ToolFailure).at === 'string' && typeof (f as ToolFailure).error === 'string')
        .slice(-KEEP_FAILURES)
    : [];
  const off = typeof r.off === 'object' && r.off !== null && typeof (r.off as { at?: unknown }).at === 'string'
    ? { at: (r.off as { at: string }).at, reason: s((r.off as { reason?: unknown }).reason) ?? 'Switched off.' }
    : null;
  const lr = r.lastRetest as { at?: unknown; ok?: unknown } | null | undefined;
  return {
    id,
    tool,
    version: s(r.version),
    testedVersion: s(r.testedVersion),
    stale: r.stale === true,
    retestDue: r.retestDue === true,
    consecutiveFailures: Number.isInteger(r.consecutiveFailures) && (r.consecutiveFailures as number) >= 0 ? (r.consecutiveFailures as number) : 0,
    failures,
    lastOk: s(r.lastOk),
    lastRetest: lr && typeof lr.at === 'string' && typeof lr.ok === 'boolean' ? { at: lr.at, ok: lr.ok } : null,
    off,
  };
}

/** The tool's health (by its stable ID), or a clean record if there's none yet. */
export async function readHealth(folder: string, tool: string, id = slugify(tool)): Promise<ToolHealth> {
  if (!id) throw new Error(`“${tool}” can’t be used as a tool name.`);
  try {
    return checkHealth(JSON.parse(await readFile(healthPath(folder, id), 'utf8')), tool, id);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || err instanceof SyntaxError) return emptyHealth(tool, id);
    throw err;
  }
}

/** Saves it (temp file, then rename, so a crash never leaves half a file). Returns the repo path. */
export async function writeHealth(folder: string, h: ToolHealth): Promise<string> {
  const path = healthPath(folder, h.id);
  await mkdir(join(folder, 'tool-health'), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(h, null, 2)}\n`);
  await rename(temp, path);
  return `tool-health/${h.id}.json`;
}

/** Every tool's health, keyed by the file's slug. */
export async function listHealth(folder: string): Promise<Map<string, ToolHealth>> {
  const out = new Map<string, ToolHealth>();
  let files: string[];
  try {
    files = (await readdir(join(folder, 'tool-health'))).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return out;
  }
  for (const f of files) {
    const slug = f.replace(/\.json$/, '');
    try {
      const raw = JSON.parse(await readFile(join(folder, 'tool-health', f), 'utf8')) as { tool?: unknown };
      out.set(slug, checkHealth(raw, typeof raw.tool === 'string' ? raw.tool : slug, slug));
    } catch {
      // a damaged file reads as no record
    }
  }
  return out;
}

/** One line in plain words for the Tools screen, or '' when all is well. */
export function healthNote(h: ToolHealth): string {
  if (h.off) return `Switched off: ${h.off.reason}`;
  const parts: string[] = [];
  if (h.stale) parts.push(`Updated to ${h.version} since it was tested. It gets a quick retest next time it’s used.`);
  else if (h.retestDue) parts.push('It gets a quick retest next time it’s used.');
  if (h.consecutiveFailures > 0) parts.push(`${h.consecutiveFailures} failure${h.consecutiveFailures === 1 ? '' : 's'} in a row.`);
  return parts.join(' ');
}

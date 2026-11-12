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

/**
 * Why a run failed (Q-3). 'model' is a model's own fault and 'tool' is a tool's own fault; only
 * these two count towards switching off. The rest (cost limit, network, provider, setup, a Stop,
 * or not clear) are recorded so they show, but never count. A record from before Q-3 has no
 * cause and reads as 'unknown'.
 */
export type FailureCause = 'model' | 'tool' | 'budget' | 'network' | 'provider' | 'setup' | 'stopped' | 'unknown';
const CAUSES: readonly string[] = ['model', 'tool', 'budget', 'network', 'provider', 'setup', 'stopped', 'unknown'];

/**
 * How far a tool is trusted. New tools start 'unknown'.
 *  - unknown: nobody has checked it.
 *  - checked: it passed its health check (see `passedHealthCheck`). The app sets this by itself.
 *  - trusted: joshua said so. Only the explicit "Trust this tool" action sets it (`setTrust`).
 *
 * Trust is written in exactly two ways, and nowhere else:
 *  1. The app: unknown becomes checked when the health check passes (in `recordRun`), and a tool
 *     switched off by the 3-failure rule drops to checked at most (in `switchOff`).
 *  2. joshua: `setTrust`, from the Capability Centre.
 * A score (health %, rating, workflow stats, test results) never changes trust.
 */
export type Trust = 'unknown' | 'checked' | 'trusted';
export const TRUST_LEVELS: readonly Trust[] = ['unknown', 'checked', 'trusted'];
const TRUST_ORDER: Record<Trust, number> = { unknown: 0, checked: 1, trusted: 2 };

export interface ToolFailure { at: string; error: string; cause?: FailureCause }

/** Only the model's or the tool's own fault counts towards switching off. */
export function countsAgainst(cause: FailureCause): boolean {
  return cause === 'model' || cause === 'tool';
}

/** The cause in plain words, for messages ("the run hit its cost limit"). */
export function causeWords(cause: FailureCause): string {
  switch (cause) {
    case 'model': return 'the model got it wrong';
    case 'tool': return 'the tool failed';
    case 'budget': return 'the run hit its cost limit';
    case 'network': return 'the internet connection dropped';
    case 'provider': return 'the provider was busy or down';
    case 'setup': return 'the API key or credit needs attention';
    case 'stopped': return 'you stopped it';
    default: return 'the cause isn’t clear';
  }
}

/**
 * CI-2: versions per computer. joshua's PC and laptop can have different versions of a tool; each
 * computer's evidence is its own, so one computer never marks the other's tool out of date.
 */
export interface ComputerVersions { version: string | null; testedVersion: string | null; stale: boolean; retestDue: boolean }

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
  /**
   * CI-2: each computer's own versions, by computer ID. The fields above show the computer that
   * used the tool last.
   */
  computers: Record<string, ComputerVersions>;
  /** How far joshua can rely on it. A record from before trust levels reads as 'unknown'. */
  trust: Trust;
}

/** Failures kept per tool. */
export const KEEP_FAILURES = 20;
const MAX_ERROR_CHARS = 300;

export function emptyHealth(tool: string, id = slugify(tool)): ToolHealth {
  return { id, tool, version: null, testedVersion: null, stale: false, retestDue: false, consecutiveFailures: 0, failures: [], lastOk: null, lastRetest: null, off: null, computers: {}, trust: 'unknown' };
}

/** The version rule, on one set of fields: first seen is the baseline, a change is stale. */
function seeVersion(c: ComputerVersions, v: string): ComputerVersions {
  if (v === c.version) return c;
  if (c.testedVersion === null) return { ...c, version: v, testedVersion: v };
  if (v === c.testedVersion) return { ...c, version: v, stale: false, retestDue: false };
  return { ...c, version: v, stale: true, retestDue: true };
}

/**
 * Notes the version in use. The first version seen becomes the baseline. A different version
 * later marks the evidence stale and schedules a retest on the next use.
 */
export function noteVersion(h: ToolHealth, version: string, computer?: string): ToolHealth {
  const v = version.trim();
  if (!v) return h;
  const top = { version: h.version, testedVersion: h.testedVersion, stale: h.stale, retestDue: h.retestDue };
  if (!computer) {
    const c = seeVersion(top, v);
    return c === top ? h : { ...h, ...c };
  }
  // A record from before CI-2 has no computers yet: its versions came from this computer.
  const known = h.computers[computer] ?? (Object.keys(h.computers).length === 0 && h.testedVersion !== null ? top : { version: null, testedVersion: null, stale: false, retestDue: false });
  const c = seeVersion(known, v);
  // A retest asked for by Switch back on (not by a version) still stands.
  return { ...h, ...c, retestDue: c.retestDue || (h.retestDue && !h.stale), computers: { ...h.computers, [computer]: c } };
}

function cleanError(error: string): string {
  const one = error.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_CHARS) || 'Failed (no message).';
  return looksLikeKey(one) ? 'Failed (the message looked like it held a key, so it wasn’t kept).' : one;
}

/**
 * Records one use of the tool. A success resets the failure count; if a retest was due, it
 * also clears the stale mark. A failure goes in the failure list with
 * its cause; it adds to the count only when the cause is the model's or the tool's own fault
 * (Q-3). Any other cause leaves the count as it was (it doesn't reset it either).
 */
export function recordRun(h: ToolHealth, run: { ok: true } | { ok: false; error?: string; cause: FailureCause }, now: Date, computer?: string): ToolHealth {
  const at = now.toISOString();
  const c = computer ? h.computers[computer] : undefined;
  const due = h.retestDue || (c?.retestDue ?? false);
  const lastRetest = due ? { at, ok: run.ok } : h.lastRetest;
  if (run.ok) {
    return promoteIfChecked({
      ...h,
      consecutiveFailures: 0,
      lastOk: at,
      lastRetest,
      ...(due ? { stale: false, retestDue: false, testedVersion: h.version } : {}),
      ...(c && computer && (c.retestDue || c.stale) ? { computers: { ...h.computers, [computer]: { ...c, stale: false, retestDue: false, testedVersion: c.version } } } : {}),
    });
  }
  const failures = [...h.failures, { at, error: cleanError(run.error ?? ''), cause: run.cause }].slice(-KEEP_FAILURES);
  return { ...h, consecutiveFailures: h.consecutiveFailures + (countsAgainst(run.cause) ? 1 : 0), failures, lastRetest };
}

/**
 * The health check, exactly: the tool's last use worked (`lastOk` is set), it has no failures in
 * a row, it isn't switched off, and its evidence isn't out of date or waiting for a retest.
 */
export function passedHealthCheck(h: ToolHealth): boolean {
  return h.lastOk !== null && h.consecutiveFailures === 0 && h.off === null && !h.stale && !h.retestDue;
}

/** Trust path 1a (the app): unknown becomes checked once the health check passes. Never touches checked or trusted. */
function promoteIfChecked(h: ToolHealth): ToolHealth {
  return h.trust === 'unknown' && passedHealthCheck(h) ? { ...h, trust: 'checked' } : h;
}

/**
 * Switches the tool off (it stays installed). Trust path 1b (the app): a trusted tool drops to
 * checked, never lower, so joshua only has to press Trust again after switching it back on.
 */
export function switchOff(h: ToolHealth, reason: string, now: Date): ToolHealth {
  return { ...h, off: { at: now.toISOString(), reason }, trust: h.trust === 'trusted' ? 'checked' : h.trust };
}

/**
 * Trust path 2 (joshua only; the engine's `tool_trust` command calls this and nothing else does).
 * Raising to trusted is allowed only from checked: a tool nobody has checked can't be trusted.
 * Lowering is allowed from anywhere; the app never raises past checked.
 */
export function setTrust(h: ToolHealth, to: Trust): ToolHealth {
  if (!TRUST_LEVELS.includes(to)) throw new Error('Trust must be unknown, checked or trusted.');
  if (to === h.trust) return h;
  if (TRUST_ORDER[to] > TRUST_ORDER[h.trust] && !(h.trust === 'checked' && to === 'trusted')) {
    throw new Error(`${h.tool} hasn’t passed its health check yet, so its trust can’t be raised yet. Use it first; the app checks it.`);
  }
  return { ...h, trust: to };
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
        .map((f) => ({ ...f, cause: CAUSES.includes(f.cause as string) ? (f.cause as FailureCause) : ('unknown' as const) }))
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
    computers: checkComputers(r.computers),
    trust: TRUST_LEVELS.includes(r.trust as Trust) ? (r.trust as Trust) : 'unknown',
  };
}

function checkComputers(raw: unknown): Record<string, ComputerVersions> {
  const out: Record<string, ComputerVersions> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null || slugify(k) !== k) continue;
    const c = v as Record<string, unknown>;
    const s = (x: unknown) => (typeof x === 'string' ? x : null);
    out[k] = { version: s(c.version), testedVersion: s(c.testedVersion), stale: c.stale === true, retestDue: c.retestDue === true };
  }
  return out;
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
  const last = h.failures.at(-1);
  if (last && last.cause && !countsAgainst(last.cause)) parts.push(`Last failure not counted: ${causeWords(last.cause)}.`);
  return parts.join(' ');
}

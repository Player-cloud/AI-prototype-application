/**
 * CI-3: evaluation results, kept in the data repo so both computers see them: one file per
 * capability, evaluations/<id>.json, newest last. memory stores; checks runs; engine decides.
 */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { slugify } from './projects.js';
import { looksLikeKey } from './sync.js';

/** The shape @aip/checks produces (kept here as data, so memory doesn't depend on checks). */
export interface StoredEval {
  suite: string;
  capability: string;
  kind: string;
  outcome: 'passed' | 'failed' | 'skipped' | 'blocked' | 'not run';
  cases: { name: string; outcome: string; detail: string }[];
  version: string;
  environment: { computer: string; os: string; node: string };
  at: string;
  ms: number;
  costUsd: number;
}

/** Results kept per capability. */
export const KEEP_EVALS = 30;
/** Fewer runs than this is a screening result, not a benchmark (architecture §12.4). */
export const SCREENING_BELOW = 3;

const file = (folder: string, id: string) => {
  if (!id || slugify(id) !== id) throw new Error(`“${id}” can’t be used as a capability ID.`);
  return join(folder, 'evaluations', `${id}.json`);
};

export async function readEvals(folder: string, id: string): Promise<StoredEval[]> {
  try {
    const raw = JSON.parse(await readFile(file(folder, id), 'utf8')) as { results?: unknown };
    return Array.isArray(raw.results) ? (raw.results as StoredEval[]).filter((r) => typeof r?.suite === 'string' && typeof r?.at === 'string') : [];
  } catch {
    return [];
  }
}

/** Adds results, one file per capability. Returns the repo paths written. */
export async function addEvals(folder: string, results: StoredEval[]): Promise<string[]> {
  if (looksLikeKey(JSON.stringify(results))) throw new Error('A test result looked like it held a key, so nothing was saved.');
  await mkdir(join(folder, 'evaluations'), { recursive: true });
  const written: string[] = [];
  for (const id of [...new Set(results.map((r) => r.capability))]) {
    const all = [...(await readEvals(folder, id)), ...results.filter((r) => r.capability === id)].slice(-KEEP_EVALS);
    const path = file(folder, id);
    const temp = `${path}.tmp-${process.pid}`;
    await writeFile(temp, `${JSON.stringify({ capability: id, results: all }, null, 2)}\n`);
    await rename(temp, path);
    written.push(`evaluations/${id}.json`);
  }
  return written;
}

/** Every capability's results, by ID. */
export async function listEvals(folder: string): Promise<Map<string, StoredEval[]>> {
  const out = new Map<string, StoredEval[]>();
  let files: string[] = [];
  try {
    files = (await readdir(join(folder, 'evaluations'))).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files.sort()) {
    const id = f.replace(/\.json$/, '');
    if (slugify(id) !== id) continue;
    const r = await readEvals(folder, id);
    if (r.length) out.set(id, r);
  }
  return out;
}

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * One line for the Tools page: the latest result of each suite, with its version, computer and
 * date, and how sure the evidence is. '' when the capability has never been tested: untested is
 * never shown as 0 or as failed.
 */
export function evidenceNote(results: StoredEval[]): string {
  if (results.length === 0) return '';
  const latest = new Map<string, StoredEval>();
  for (const r of results) latest.set(r.suite, r);
  const parts = [...latest.values()].map((r) => {
    const cases = r.cases.filter((c) => c.outcome === 'passed').length;
    return `${r.outcome} (${cases}/${r.cases.length}) on ${r.environment.computer}${r.version ? `, version ${r.version}` : ''}, ${day(r.at)}`;
  });
  const runs = results.length;
  const sure = runs < SCREENING_BELOW ? `${runs} run${runs === 1 ? '' : 's'} so far: a first look, not proof` : `${runs} runs`;
  return `Tests: ${parts.join('; ')}. ${sure}.`;
}

/** CI-5: a test that did worse after the tool's version changed, on the same computer. */
export interface Regression {
  capability: string;
  suite: string;
  computer: string;
  from: string;
  to: string;
  before: string;
  after: string;
  at: string;
}

const counted = (r: StoredEval) => r.outcome === 'passed' || r.outcome === 'failed';
const score = (r: StoredEval) => (r.cases.length ? r.cases.filter((c) => c.outcome === 'passed').length / r.cases.length : 0);
const said = (r: StoredEval) => `${r.outcome} (${r.cases.filter((c) => c.outcome === 'passed').length}/${r.cases.length})`;

/**
 * Regression check: for each test on each computer, the newest result against the last one on a
 * different version. Worse means it failed where it passed, or got fewer cases right. Tests that
 * couldn't run, and results with no version, are never compared.
 */
export function findRegressions(results: StoredEval[]): Regression[] {
  const groups = new Map<string, StoredEval[]>();
  for (const r of results) {
    if (!counted(r) || !r.version) continue;
    const k = `${r.capability}\u0000${r.suite}\u0000${r.environment.computer}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: Regression[] = [];
  for (const rs of groups.values()) {
    const sorted = [...rs].sort((a, b) => a.at.localeCompare(b.at));
    const latest = sorted.at(-1)!;
    const before = sorted.filter((r) => r.version !== latest.version).at(-1);
    if (!before) continue;
    const worse = (before.outcome === 'passed' && latest.outcome === 'failed') || score(latest) < score(before);
    if (!worse) continue;
    out.push({
      capability: latest.capability,
      suite: latest.suite,
      computer: latest.environment.computer,
      from: before.version,
      to: latest.version,
      before: said(before),
      after: said(latest),
      at: latest.at,
    });
  }
  return out.sort((a, b) => a.capability.localeCompare(b.capability) || a.suite.localeCompare(b.suite) || a.computer.localeCompare(b.computer));
}

/** "Got worse after updating from 11.2.5 to 11.3.0 on lapto: passed (4/4) before, failed (3/4) now." */
export function regressionNote(regs: Regression[]): string {
  return regs.map((r) => `Got worse after updating from ${r.from} to ${r.to} on ${r.computer} (${r.suite}): ${r.before} before, ${r.after} now.`).join(' ');
}

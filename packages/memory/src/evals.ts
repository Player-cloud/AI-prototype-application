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

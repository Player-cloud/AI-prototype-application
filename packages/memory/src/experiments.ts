/**
 * CI-5: controlled experiments, kept in the data repo as experiments/<id>.json. Each one states its
 * question, its fixed inputs, what it measures, and its result. A result is a proposal: nothing is
 * changed, installed or switched because of it until joshua adopts it. memory stores; checks runs.
 */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { looksLikeKey } from './sync.js';

export interface Experiment {
  id: string;
  question: string;
  capability: string;
  /** What was held fixed: the test and how many times it ran. */
  inputs: { suite: string; runs: number };
  measures: string[];
  result: { outcomes: string[]; passedRuns: number; casesRight: string[]; msMin: number; msMax: number; version: string };
  /** Plain words: what the result says. */
  verdict: string;
  /** Always a proposal until joshua adopts it. */
  status: 'proposal' | 'adopted' | 'dropped';
  environment: { computer: string; os: string; node: string };
  at: string;
  costUsd: number;
}

/** Experiments kept; older ones are dropped. */
export const KEEP_EXPERIMENTS = 50;

/** Lowercase words and digits joined by dashes: safe as a file name on Windows and Linux. */
const SAFE_ID = /^(?=.{1,80}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

const dir = (folder: string) => join(folder, 'experiments');

export async function saveExperiment(folder: string, e: Experiment): Promise<string> {
  if (!SAFE_ID.test(e.id)) throw new Error(`“${e.id}” can’t be used as an experiment ID.`);
  if (looksLikeKey(JSON.stringify(e))) throw new Error('The experiment looked like it held a key, so it wasn’t saved.');
  await mkdir(dir(folder), { recursive: true });
  const path = join(dir(folder), `${e.id}.json`);
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(e, null, 2)}\n`);
  await rename(temp, path);
  return `experiments/${e.id}.json`;
}

/** Newest first. Damaged files are skipped. */
export async function listExperiments(folder: string): Promise<Experiment[]> {
  let files: string[] = [];
  try {
    files = (await readdir(dir(folder))).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Experiment[] = [];
  for (const f of files) {
    try {
      const e = JSON.parse(await readFile(join(dir(folder), f), 'utf8')) as Experiment;
      if (typeof e.id === 'string' && typeof e.question === 'string' && typeof e.at === 'string' && e.result && Array.isArray(e.result.outcomes)) out.push(e);
    } catch {
      // skipped
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, KEEP_EXPERIMENTS);
}

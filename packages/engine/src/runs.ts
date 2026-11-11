/**
 * Step 8a: each feature build runs in its own git worktree, a separate copy of the project's code
 * on its own branch (aip/<feature>-<time>), next to the code folder in "<folder>-runs/". joshua's
 * own copy isn't touched until he presses Keep (step 9). One feature per run.
 */
import { stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { AppSettings } from './settings.ts';
import { getInterview } from './projects.ts';

export type Git = (args: string[], cwd: string) => Promise<string>;

export interface CodeFolderStatus {
  folder: string;
  /** The branch checked out in joshua's copy. */
  branch: string;
  /** False when joshua's copy has changes not yet committed (runs start from the last commit). */
  clean: boolean;
  runs: RunInfo[];
}

export interface RunInfo { path: string; branch: string; feature: string }

export interface StartedRun extends RunInfo { base: string }

const FEATURE_ID = /^F-\d{2,3}$/;

async function defaultGit(): Promise<Git> {
  return (await import('@aip/memory')).realGit;
}

export function codeFolderOf(settings: AppSettings, slug: string): string {
  const folder = settings.codeFolders[slug];
  if (!folder) throw new Error('Set this project’s code folder first: where its repo is cloned on this computer.');
  return folder;
}

const same = (a: string, b: string) => {
  const n = (p: string) => resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/** "2026-11-11T16:05:09Z" -> "20261111-160509". */
export function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/** Feature runs from `git worktree list --porcelain`: only the app's aip/ branches. */
export function parseWorktrees(porcelain: string): RunInfo[] {
  const out: RunInfo[] = [];
  for (const block of porcelain.split(/\r?\n\r?\n/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    const branch = block.match(/^branch refs\/heads\/(aip\/.+)$/m)?.[1];
    if (!path || !branch) continue;
    const feature = branch.match(/^aip\/(f-\d{2,3})-/)?.[1]?.toUpperCase() ?? '';
    out.push({ path, branch, feature });
  }
  return out;
}

/** Checks the folder is the top of a git repo with at least one commit. */
export async function checkCodeFolder(folder: string, git?: Git): Promise<CodeFolderStatus> {
  const g = git ?? (await defaultGit());
  try {
    if (!(await stat(folder)).isDirectory()) throw new Error('not a folder');
  } catch {
    throw new Error(`Can’t find the folder ${folder}.`);
  }
  let top: string;
  try {
    top = (await g(['rev-parse', '--show-toplevel'], folder)).trim();
  } catch {
    throw new Error(`${folder} isn’t a git repo. Clone the project’s repo there first.`);
  }
  if (!same(top, folder)) throw new Error(`Choose the top of the repo (${top}), not a folder inside it.`);
  try {
    await g(['rev-parse', '--verify', 'HEAD'], folder);
  } catch {
    throw new Error('The repo has no commits yet. Make a first commit, then try again.');
  }
  const branch = (await g(['rev-parse', '--abbrev-ref', 'HEAD'], folder)).trim();
  const clean = (await g(['status', '--porcelain'], folder)).trim() === '';
  const runs = parseWorktrees(await g(['worktree', 'list', '--porcelain'], folder));
  return { folder, branch, clean, runs };
}

/**
 * Makes a new worktree for one feature, from the last commit of joshua's copy. Never reuses or
 * overwrites an earlier run.
 */
export async function startRun(settings: AppSettings, slug: string, feature: string, now: Date, git?: Git): Promise<StartedRun> {
  if (!FEATURE_ID.test(feature)) throw new Error(`“${feature}” isn’t a feature ID like F-01.`);
  const { interview, finished } = await getInterview(settings, slug);
  if (!finished) throw new Error('Finish the plan interview first: a build follows the spec.');
  if (!interview.features.some((f) => f.id === feature)) throw new Error(`There’s no ${feature} in this project’s spec.`);
  const g = git ?? (await defaultGit());
  const status = await checkCodeFolder(codeFolderOf(settings, slug), g);
  const folder = status.folder;
  const branch = `aip/${feature.toLowerCase()}-${stamp(now)}`;
  const path = join(dirname(resolve(folder)), `${basename(resolve(folder))}-runs`, `${feature}-${stamp(now)}`);
  const base = (await g(['rev-parse', 'HEAD'], folder)).trim();
  try {
    await g(['worktree', 'add', '-b', branch, path, base], folder);
  } catch (err) {
    throw new Error(`Couldn’t make a separate copy for ${feature}: ${(err as Error).message}`);
  }
  return { path, branch, feature, base };
}

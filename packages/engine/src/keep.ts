/**
 * Step 9a: Keep or Undo a feature build, and joshua's 1–5 rating.
 *
 * Keep merges the build's branch into joshua's own copy (a merge commit on the branch he has
 * checked out, never a push), then removes the build's copy. It's refused when the tests fail or
 * his copy has changes not committed yet, and nothing changes when the merge would clash.
 * Undo removes the build's copy and branch; his own copy is never touched.
 */
import type { Run } from '@aip/memory';
import type { AppSettings } from './settings.ts';
import { checkCodeFolder, codeFolderOf, type Git } from './runs.ts';

export type RunRow = Run;

export interface KeepResult { run: Run; note: string }

async function withRuns<T>(dbPath: string, fn: (log: import('@aip/memory').RunLog) => T | Promise<T>): Promise<T> {
  const m = await import('@aip/memory');
  const log = m.RunLog.open(dbPath);
  try {
    return await fn(log);
  } finally {
    log.close();
  }
}

async function gitOf(git?: Git): Promise<Git> {
  return git ?? (await import('@aip/memory')).realGit;
}

export function listRuns(dbPath: string, slug?: string): Promise<Run[]> {
  return withRuns(dbPath, (log) => log.list(slug));
}

export function rateRun(dbPath: string, id: number, rating: number): Promise<Run> {
  return withRuns(dbPath, (log) => {
    log.rate(id, rating);
    return log.get(id)!;
  });
}

function waiting(log: import('@aip/memory').RunLog, id: number): Run {
  const run = log.get(id);
  if (!run) throw new Error('There’s no such build.');
  if (run.status !== 'built') throw new Error(`That build was already ${run.status === 'kept' ? 'kept' : 'undone'}.`);
  return run;
}

/** Removes the build's copy and, when asked, its branch. Problems here don't undo a Keep. */
async function tidy(g: Git, folder: string, run: Run, dropBranch: 'merged' | 'force'): Promise<string> {
  const problems: string[] = [];
  try {
    await g(['worktree', 'remove', '--force', run.path], folder);
  } catch {
    try {
      await g(['worktree', 'prune'], folder); // the copy was already deleted by hand
    } catch {
      problems.push(`remove ${run.path} by hand`);
    }
  }
  try {
    await g(['branch', dropBranch === 'merged' ? '-d' : '-D', run.branch], folder);
  } catch {
    problems.push(`branch ${run.branch} is still there`);
  }
  return problems.length ? ` Tidy-up left something: ${problems.join('; ')}.` : '';
}

export async function keepRun(settings: AppSettings, dbPath: string, id: number, now: Date, git?: Git): Promise<KeepResult> {
  const g = await gitOf(git);
  return withRuns(dbPath, async (log) => {
    const run = waiting(log, id);
    if (!run.testsPassed) throw new Error('The tests fail, so this build can’t be kept. Undo it, or build the feature again.');
    const folder = codeFolderOf(settings, run.slug);
    const status = await checkCodeFolder(folder, g);
    if (!status.clean) throw new Error(`Your copy (${folder}) has changes not committed yet. Commit them or put them aside, then press Keep again.`);
    if (status.branch === 'HEAD') throw new Error('Your copy isn’t on a branch. Check out a branch, then press Keep again.');

    // The build model may leave its work uncommitted: commit it on the build's own branch first.
    if ((await g(['status', '--porcelain'], run.path)).trim() !== '') {
      await g(['add', '-A'], run.path);
      await g(['commit', '-q', '-m', `${run.feature}: built by AI Prototype`], run.path);
    }
    try {
      await g(['merge', '--no-ff', '-m', `Keep ${run.feature} (build ${run.branch})`, run.branch], folder);
    } catch (err) {
      try {
        await g(['merge', '--abort'], folder);
      } catch {
        // nothing to abort
      }
      throw new Error(`Couldn’t keep ${run.feature}: it clashes with changes in your copy, so nothing was changed. Undo it and build it again from your latest code. (${(err as Error).message.split('\n')[0]})`);
    }
    const mergeCommit = (await g(['rev-parse', 'HEAD'], folder)).trim();
    log.decide(id, 'kept', now, { mergeCommit, keptInto: status.branch });
    const left = await tidy(g, folder, run, 'merged');
    return { run: log.get(id)!, note: `Kept ${run.feature} in your copy on ${status.branch}. Nothing was pushed.${left}` };
  });
}

export async function undoRun(settings: AppSettings, dbPath: string, id: number, now: Date, git?: Git): Promise<KeepResult> {
  const g = await gitOf(git);
  return withRuns(dbPath, async (log) => {
    const run = waiting(log, id);
    const folder = codeFolderOf(settings, run.slug);
    const left = await tidy(g, folder, run, 'force');
    log.decide(id, 'undone', now);
    return { run: log.get(id)!, note: `Undone: ${run.feature}’s build was removed. Your copy wasn’t touched.${left}` };
  });
}

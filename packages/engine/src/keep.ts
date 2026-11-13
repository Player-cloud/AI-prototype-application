/**
 * Step 9a: Keep or Undo a feature build, and joshua's 1–5 rating.
 *
 * Keep merges the build's branch into joshua's own copy (a merge commit on the branch he has
 * checked out, never a push), then removes the build's copy. It's refused when the tests fail or
 * his copy has changes not committed yet, and nothing changes when the merge would clash.
 * Undo removes the build's copy and branch; his own copy is never touched.
 * Undo a kept build adds a new commit that reverses the merge (git revert). History is never
 * rewritten, reset or pushed.
 */
import type { Run } from '@aip/memory';
import type { AppSettings } from './settings.ts';
import { checkCodeFolder, codeFolderOf, type Git } from './runs.ts';
import { mapPrediction, readMap, updateMapAfterKeep, updateMapAfterRevert } from './project-map.ts';

export type RunRow = Run;

/** "The map named 4 of 5 files this build changed (80%)" */
export function mapScoreText(named: number, changed: number): string {
  return `The map named ${named} of ${changed} file${changed === 1 ? '' : 's'} this build changed (${Math.round((named / changed) * 100)}%)`;
}

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

/** Said when Keep is refused because the build added packages joshua hasn't OK'd (also on the phone). */
export const NEEDS_APPROVAL = 'This build added new packages, and they need your OK first. Open the app on your PC, press “Approve new packages” on the build, then keep it.';

export interface ApproveResult { run: Run; note: string; keep: { keep: boolean; blocking: string[] } }

/**
 * joshua's OK for the new packages of one waiting build. The build's saved `dependencies` check
 * becomes passed (with who, when and which packages), and the OK goes in the change history.
 * Keep then works from the saved checks, so nothing else is needed.
 */
export async function approveDeps(dbPath: string, id: number, now: Date): Promise<ApproveResult> {
  const { NEW_PACKAGE, blockingChecks } = await import('@aip/checks');
  const { approvalRecorded } = await import('./history.ts');
  const result = await withRuns(dbPath, (log) => {
    const run = waiting(log, id);
    const check = run.findings.find((f) => f.check === 'dependencies' && f.level === 'block');
    if (!check) throw new Error('This build has no new packages waiting for your OK.');
    const packages = (check.detail ?? '').split('\n').filter((l) => l.startsWith(NEW_PACKAGE)).map((l) => l.slice(NEW_PACKAGE.length));
    const detail = `Approved by you on ${now.toISOString().slice(0, 10)}: ${packages.join('; ')}`;
    log.setFindings(id, run.findings.map((f) => (f === check ? { check: f.check, level: 'pass' as const, title: 'New packages: approved by you', detail, source: f.source } : f)));
    return { run: log.get(id)!, detail, packages };
  });
  await approvalRecorded(dbPath, `Approved new packages for ${result.run.feature}: ${result.packages.join(', ')}`, result.detail, now);
  const blocking = blockingChecks(result.run.findings);
  if (!result.run.testsPassed) blocking.unshift('tests');
  return { run: result.run, note: `Approved the new packages for ${result.run.feature}: ${result.packages.join(', ')}.`, keep: { keep: blocking.length === 0, blocking } };
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
  if (run.status !== 'built') throw new Error(NOT_WAITING[run.status]);
  return run;
}

const NOT_WAITING: Record<Run['status'], string> = {
  built: '',
  kept: 'That build was already kept.',
  undone: 'That build was already undone.',
  reverted: 'That kept build was already undone.',
  running: 'That build is still running.',
  failed: 'That build failed, so it can’t be kept.',
  stopped: 'That build was stopped, so it can’t be kept.',
  interrupted: 'That build was interrupted, so it can’t be kept.',
};

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
    const { blockingChecks } = await import('@aip/checks');
    const blocking = blockingChecks(run.findings);
    const others = blocking.filter((n) => n !== 'dependencies');
    if (others.length) throw new Error(`These checks must pass before it can be kept: ${others.join(', ')}. Undo it, or build the feature again.`);
    if (blocking.includes('dependencies')) throw new Error(NEEDS_APPROVAL);
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
    // Project map: what this build changed (read before the build's branch goes). A map problem never fails Keep.
    let mapNote: string;
    let scoreNote = '';
    try {
      const changed = (await g(['diff', '--name-only', '-z', '--no-renames', `${run.base}..${run.branch}`], folder)).split('\0').filter(Boolean);
      // A maintenance item (dev-tool patch update) is not a feature: the map isn't touched.
      const isFeature = run.model !== (await import('@aip/memory')).MAINTENANCE_MODEL;
      // How well did the map predict these files? Measured before the map is refreshed with them.
      if (isFeature) {
        try {
          const hit = await mapPrediction((await readMap(settings, run.slug)).features[run.feature], changed);
          if (hit) {
            log.setMapHit(id, hit.hit, hit.changed);
            scoreNote = ` ${mapScoreText(hit.named, hit.changed)}.`;
          }
        } catch {
          // not measured: never fails Keep
        }
      }
      mapNote = !isFeature ? '' : await updateMapAfterKeep(settings, run.slug, { feature: run.feature, buildId: id, keptAt: now, changed }, folder);
    } catch (err) {
      mapNote = ` The project map wasn’t updated (${(err as Error).message.split('\n')[0]}).`;
    }
    const left = await tidy(g, folder, run, 'merged');
    return { run: log.get(id)!, note: `Kept ${run.feature} in your copy on ${status.branch}. Nothing was pushed.${left}${scoreNote}${mapNote}` };
  });
}

export async function undoRun(settings: AppSettings, dbPath: string, id: number, now: Date, git?: Git): Promise<KeepResult> {
  const g = await gitOf(git);
  return withRuns(dbPath, async (log) => {
    const run = log.get(id);
    if (!run) throw new Error('There’s no such build.');
    // A failed, stopped or interrupted build can't be kept, but its copy of the code is still on disk.
    // Undo removes that copy and branch like for a built one. The record stays (status and cause are
    // what History and the comparisons learn from); it's only marked as cleaned, so Undo isn't offered again.
    if (run.status === 'failed' || run.status === 'stopped' || run.status === 'interrupted') {
      const left = await tidy(g, codeFolderOf(settings, run.slug), run, 'force');
      log.markCleaned(id, now);
      return { run: log.get(id)!, note: `Removed ${run.feature}’s unfinished build copy. The record of what happened stays in the list. Your copy wasn’t touched.${left}` };
    }
    waiting(log, id);
    const folder = codeFolderOf(settings, run.slug);
    const left = await tidy(g, folder, run, 'force');
    log.decide(id, 'undone', now);
    return { run: log.get(id)!, note: `Undone: ${run.feature}’s build was removed. Your copy wasn’t touched.${left}` };
  });
}

/** The files a kept merge changed, for the project map. */
async function keptFiles(g: Git, folder: string, commit: string, parents: number): Promise<string[]> {
  const from = parents > 1 ? `${commit}^1` : `${commit}^`;
  return (await g(['diff', '--name-only', '-z', '--no-renames', from, commit], folder)).split('\0').filter(Boolean);
}

/**
 * Undo a kept build: a NEW commit in joshua's copy reverses the merge Keep made. Nothing is reset,
 * forced, rewritten or pushed. Refused, with nothing changed, when the build isn't kept, his copy
 * has changes not committed yet, the kept commit isn't in the branch he has checked out, or the
 * reversal clashes with later work (it is aborted and the clashing files are named).
 */
export async function revertKept(
  settings: AppSettings,
  dbPath: string,
  id: number,
  now: Date,
  git?: Git,
  runTests?: (dir: string) => Promise<import('@aip/checks').CheckResult>,
): Promise<KeepResult> {
  const g = await gitOf(git);
  const { revertRecorded } = await import('./history.ts');
  const result = await withRuns(dbPath, async (log) => {
    const run = log.get(id);
    if (!run) throw new Error('There’s no such build.');
    if (run.status !== 'kept') throw new Error(run.status === 'reverted' ? NOT_WAITING.reverted : 'Only a kept build can be undone this way.');
    const commit = run.mergeCommit;
    if (!/^[0-9a-f]{7,64}$/i.test(commit)) throw new Error('The app has no record of which commit kept this build, so it can’t be reversed safely. Nothing was changed.');
    const folder = codeFolderOf(settings, run.slug);
    const status = await checkCodeFolder(folder, g);
    if (!status.clean) throw new Error(`Your copy (${folder}) has changes not committed yet. Commit them or put them aside, then press Undo this kept build again. Nothing was changed.`);
    if (status.branch === 'HEAD') throw new Error('Your copy isn’t on a branch. Check out a branch, then try again. Nothing was changed.');
    const notThere = `The commit that kept ${run.feature} isn’t in the history of ${status.branch}, so it can’t be reversed here. Check out the branch it was kept into${run.keptInto ? ` (${run.keptInto})` : ''}. Nothing was changed.`;
    try {
      await g(['cat-file', '-e', `${commit}^{commit}`], folder);
      await g(['merge-base', '--is-ancestor', commit, 'HEAD'], folder);
    } catch {
      throw new Error(notThere);
    }
    const subject = (await g(['log', '-1', '--format=%s', commit], folder)).trim();
    if (!subject.startsWith(`Keep ${run.feature} (build `)) throw new Error(notThere);
    const parents = (await g(['rev-list', '--parents', '-n', '1', commit], folder)).trim().split(/\s+/).length - 1;
    const changed = await keptFiles(g, folder, commit, parents);
    const before = (await g(['rev-parse', 'HEAD'], folder)).trim();
    try {
      await g(['revert', '--no-edit', ...(parents > 1 ? ['-m', '1'] : []), commit], folder);
    } catch (err) {
      let clash: string[] = [];
      try {
        clash = (await g(['diff', '--name-only', '--diff-filter=U'], folder)).split(/\r?\n/).filter(Boolean);
      } catch {
        // can't list them: the plain message below still says nothing changed
      }
      try {
        await g(['revert', '--abort'], folder);
      } catch {
        // nothing to abort
      }
      const why = clash.length ? `these files clash with later changes: ${clash.join(', ')}` : (err as Error).message.split('\n')[0];
      throw new Error(`Couldn’t undo ${run.feature}: ${why}. Nothing was changed.`);
    }
    const revertCommit = (await g(['rev-parse', 'HEAD'], folder)).trim();
    if (revertCommit === before) throw new Error(`Couldn’t undo ${run.feature}: git made no new commit. Nothing was changed.`);
    log.markReverted(id);
    return { run, folder, status, commit, revertCommit, changed };
  });
  const { run, folder, status, commit, revertCommit, changed } = result;
  // History and map are best-effort from here: the revert already happened and the status is saved.
  let extra = '';
  try {
    await revertRecorded(dbPath, `Undid kept build: ${run.feature}`, folder, commit, revertCommit, now);
  } catch (err) {
    extra += ` The change history wasn’t updated (${(err as Error).message.split('\n')[0]}).`;
  }
  extra += await updateMapAfterRevert(settings, run.slug, { feature: run.feature, changed, at: now }, folder);
  extra += ` ${await testsAfterUndo(folder, runTests)}`;
  const done = await withRuns(dbPath, (log) => log.get(id)!);
  return { run: done, note: `Undid ${run.feature}: a new commit on ${status.branch} reverses it. Nothing was pushed and no history was rewritten.${extra}` };
}

/** What the tests said in the code folder after Undo, in one line. Failing tests never undo the revert. */
async function testsAfterUndo(folder: string, runTests?: (dir: string) => Promise<import('@aip/checks').CheckResult>): Promise<string> {
  try {
    // Same as a build: packages are installed with --ignore-scripts when the folder has none.
    const t = await (runTests ?? (await import('@aip/checks')).runTests)(folder);
    if (t.passed) return 'Tests after undo: passed.';
    const first = (t.detail ?? '').split(/\r?\n/).find((l) => l.trim()) ?? 'unknown reason';
    if (/^(No package\.json|package\.json has no "test" script|Installing packages failed)/.test(first)) return `Tests after undo: couldn’t run (${first.split(/\.(?:\s|$)/)[0]!.replace(/:$/, '')}).`;
    const failed = (t.cases ?? []).filter((c) => !c.passed).length;
    return failed > 0 ? `Tests after undo: ${failed} failed.` : 'Tests after undo: failed.';
  } catch (err) {
    return `Tests after undo: couldn’t run (${(err as Error).message.split('\n')[0]}).`;
  }
}

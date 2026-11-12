/**
 * Step 10b: work items. When a build finishes, it needs joshua (Keep or Undo), so the app keeps a
 * work item for it and, with a GitHub token saved, posts it as an issue on the data repo so his
 * phone shows it. When he keeps or undoes the build, the item closes and so does the issue.
 * GitHub problems never stop a build or a Keep: they're reported in plain words instead.
 */
import type { WorkItem } from '@aip/memory';
import { GitHub, messagesRepo, type Fetch } from './github.ts';
import type { AppSettings } from './settings.ts';

/** Marks the app's own posts, so it never reads them as joshua's replies (10c). */
export const SIGNATURE = '_Posted by AI Prototype._';

export interface BuildNews {
  slug: string;
  feature: string;
  featureName?: string;
  testsPassed: boolean;
  fixAttempts: number;
  blocking: string[];
  advice: string[];
  costText: string;
  screensChanged: boolean | null;
  summary: string;
}

export function buildTitle(n: BuildNews): string {
  const what = n.testsPassed && !n.blocking.length ? 'built, waiting for Keep or Undo' : 'built, but it can’t be kept: Undo it';
  return `${n.slug} ${n.feature}: ${what}`;
}

export function buildBody(n: BuildNews): string {
  const fixes = n.fixAttempts ? ` (${n.fixAttempts} fix attempt${n.fixAttempts === 1 ? '' : 's'})` : '';
  return [
    `**${n.feature}${n.featureName ? ` (${n.featureName})` : ''}** in **${n.slug}** was built.`,
    '',
    `- Tests: ${n.testsPassed ? 'pass' : 'fail'}${fixes}`,
    `- Checks: ${n.blocking.length ? `must pass first: ${n.blocking.join(', ')}` : 'nothing blocks Keep'}${n.advice.length ? `; see notes on ${n.advice.join(', ')}` : ''}`,
    `- Cost: ${n.costText}`,
    `- Screens: ${n.screensChanged === null ? 'no earlier pictures to compare' : n.screensChanged ? 'changed since the last build' : 'same as the last build'}`,
    '',
    '> ' + (n.summary.trim().slice(0, 1500) || 'No summary.').replace(/\n/g, '\n> '),
    '',
    'Reply here with **keep**, **undo**, or a rating from **1** to **5**, or use the app on your PC. The app reads replies about once a minute while it’s open.',
    '',
    SIGNATURE,
  ].join('\n');
}

async function withItems<T>(dbPath: string, fn: (w: import('@aip/memory').WorkItems) => T | Promise<T>): Promise<T> {
  const m = await import('@aip/memory');
  const w = m.WorkItems.open(dbPath);
  try {
    return await fn(w);
  } finally {
    w.close();
  }
}

/** Saves the work item and posts it to GitHub when a token is saved. Returns a plain-words note. */
export async function postBuild(
  settings: AppSettings,
  dbPath: string,
  runId: number,
  news: BuildNews,
  token: string | undefined,
  now: Date,
  fetchImpl?: Fetch,
): Promise<string> {
  const title = buildTitle(news);
  const id = await withItems(dbPath, (w) => w.add(now, 'build', runId, title));
  if (!token) return 'Not sent to your phone: add a GitHub token in Settings for that.';
  const body = buildBody(news);
  const { looksLikeKey } = await import('@aip/memory');
  if (looksLikeKey(body)) return 'Not sent to your phone: the build’s summary has something that looks like a key.';
  try {
    const gh = new GitHub(token, await messagesRepo(settings), fetchImpl);
    const issue = await gh.createIssue(title, body);
    await withItems(dbPath, (w) => w.posted(id, issue.number, issue.url, now));
    return `Sent to your phone: issue #${issue.number} on ${gh.repo}.`;
  } catch (err) {
    return `Couldn’t message your phone: ${(err as Error).message}`;
  }
}

/** After Keep or Undo on the PC: closes the build's item, and its issue with a short reply. */
export async function closeBuild(
  settings: AppSettings,
  dbPath: string,
  runId: number,
  note: string,
  token: string | undefined,
  now: Date,
  fetchImpl?: Fetch,
): Promise<string> {
  const item = await withItems(dbPath, (w) => {
    const it = w.forRun(runId);
    if (it) w.done(it.id, now);
    return it;
  });
  if (!item?.issue || !token) return '';
  try {
    const gh = new GitHub(token, await messagesRepo(settings), fetchImpl);
    await gh.comment(item.issue, `${note} (Done on the PC.)\n\n${SIGNATURE}`);
    await gh.close(item.issue);
    return `Closed issue #${item.issue} on your phone.`;
  } catch (err) {
    return `Couldn’t update your phone: ${(err as Error).message}`;
  }
}

/** The "Needs you" panel. */
export function listWork(dbPath: string): Promise<WorkItem[]> {
  return withItems(dbPath, (w) => w.listOpen());
}

/**
 * Step 10c: joshua answers from his phone. While the app is open it reads new replies on the open
 * work items' issues about once a minute. "keep", "undo" or a rating from 1 to 5 does the same as
 * the buttons on the PC; the app answers on the issue so he sees what happened. Only replies from
 * people with access to the private data repo count, and the app never acts on its own replies.
 */
import type { WorkItem } from '@aip/memory';
import { GitHub, messagesRepo, type Comment, type Fetch } from './github.ts';
import { keepRun, rateRun, undoRun } from './keep.ts';
import { SIGNATURE } from './notify.ts';
import { answerControl, type BuildRequest } from './phone.ts';
import { parseAnswer, questionsIn, saveAnswer } from './questions.ts';
import type { AppSettings } from './settings.ts';

export type Reply = { kind: 'keep' } | { kind: 'undo' } | { kind: 'rate'; rating: number } | { kind: 'unknown' };

const TRUSTED = new Set(['OWNER', 'COLLABORATOR', 'MEMBER']);

/** What a reply asks for: the first line only, so a longer note under it is fine. */
export function parseReply(body: string): Reply {
  const first = (body.trim().split('\n')[0] ?? '').trim().toLowerCase().replace(/[.!]+$/, '');
  if (first === 'keep' || first === 'keep it') return { kind: 'keep' };
  if (first === 'undo' || first === 'undo it') return { kind: 'undo' };
  const n = /^(?:rate\s+|rating\s+)?([1-5])(?:\s*\/\s*5)?$/.exec(first);
  if (n) return { kind: 'rate', rating: Number(n[1]) };
  return { kind: 'unknown' };
}

const fromJoshua = (c: Comment) => TRUSTED.has(c.role) && !c.body.includes(SIGNATURE);

export interface PollResult {
  /** Plain notes on what was done, for the screen. */
  done: string[];
  /** True when something changed (a build kept, undone or rated). */
  changed: boolean;
  /** D: builds the phone asked for, already checked. The desktop starts them (at most one). */
  builds: BuildRequest[];
}

type Learn = () => Promise<string[]>;

/** Reads new replies on every open item's issue and acts on them. GitHub problems are notes, never errors. */
export async function pollReplies(
  settings: AppSettings,
  dbPath: string,
  token: string,
  now: () => Date,
  learn: Learn,
  fetchImpl?: Fetch,
  /** A build is running now, so the phone can't start another. */
  busy = false,
): Promise<PollResult> {
  const m = await import('@aip/memory');
  const items = (() => {
    const w = m.WorkItems.open(dbPath);
    try {
      return w.listOpen().filter((i) => i.issue > 0);
    } finally {
      w.close();
    }
  })();
  const out: PollResult = { done: [], changed: false, builds: [] };
  if (!items.length) return out;
  let gh: GitHub;
  try {
    gh = new GitHub(token, await messagesRepo(settings), fetchImpl);
  } catch (err) {
    return { ...out, done: [`Couldn’t read phone replies: ${(err as Error).message}`] };
  }
  for (const item of items) {
    try {
      if (item.kind === 'control') {
        const r = await answerControl(item, gh, settings, dbPath, now, busy || out.builds.length > 0, fromJoshua);
        out.done.push(...r.done);
        out.builds.push(...r.builds);
        continue;
      }
      await answer(item, gh, settings, dbPath, now, learn, out);
    } catch (err) {
      out.done.push(`Couldn’t read replies on issue #${item.issue}: ${(err as Error).message}`);
    }
  }
  return out;
}

async function answer(item: WorkItem, gh: GitHub, settings: AppSettings, dbPath: string, now: () => Date, learn: Learn, out: PollResult) {
  const m = await import('@aip/memory');
  const since = item.readUpTo ?? item.at;
  // GitHub's `since` includes the same second, so replies already read are skipped by time.
  const replies = (await gh.comments(item.issue, since)).filter((c) => c.at > since && fromJoshua(c));
  for (const c of replies) {
    // D: an answer to one of the model's questions. Kept for later builds; the build stays open.
    const ans = parseAnswer(c.body);
    if (ans) {
      let text: string;
      try {
        const run = (() => {
          const log = m.RunLog.open(dbPath);
          try {
            return log.get(item.runId);
          } finally {
            log.close();
          }
        })();
        if (!run) throw new Error('That build isn’t in the history any more.');
        const qs = questionsIn(run.summary);
        const q = qs[ans.n - 1];
        if (!q) throw new Error(qs.length ? `There’s no question ${ans.n}: this build asked ${qs.length}.` : 'This build didn’t ask any questions.');
        text = `Answer ${ans.n} ${await saveAnswer(settings, run.slug, run.feature, q, ans.text, now())}`;
      } catch (err) {
        text = (err as Error).message;
      }
      await gh.comment(item.issue, `${text}\n\n${SIGNATURE}`);
      out.done.push(`From your phone (issue #${item.issue}): ${text}`);
      const w = m.WorkItems.open(dbPath);
      try {
        w.readTo(item.id, c.at);
      } finally {
        w.close();
      }
      continue;
    }
    const reply = parseReply(c.body);
    let text: string;
    let closes = false;
    try {
      if (reply.kind === 'keep' || reply.kind === 'undo') {
        const r = reply.kind === 'keep' ? await keepRun(settings, dbPath, item.runId, now()) : await undoRun(settings, dbPath, item.runId, now());
        text = r.note;
        closes = true;
        out.changed = true;
      } else if (reply.kind === 'rate') {
        const r = await rateRun(dbPath, item.runId, reply.rating);
        text = `Rated ${r.feature} ${reply.rating}/5.`;
        out.changed = true;
      } else {
        text = 'Sorry, I didn’t understand that. Reply **keep**, **undo**, a rating from **1** to **5**, or **answer 1:** and your answer to a question.';
      }
    } catch (err) {
      text = `${(err as Error).message}`;
    }
    const learned = reply.kind === 'unknown' ? [] : await learn();
    const body = [text, ...learned.map((l) => `- ${l}`)].join('\n');
    await gh.comment(item.issue, `${body}\n\n${SIGNATURE}`);
    out.done.push(`From your phone (issue #${item.issue}): ${text}`);
    const w = m.WorkItems.open(dbPath);
    try {
      w.readTo(item.id, c.at);
      if (closes) w.done(item.id, now());
    } finally {
      w.close();
    }
    if (closes) {
      await gh.close(item.issue);
      return; // the build is decided; later replies have nothing to act on
    }
  }
}

/**
 * V2 item D (part 1): start a build from the phone. The app keeps one issue on the private data
 * repo, "Start builds from here". joshua replies on it with a command; while the app is open it
 * reads the replies (about once a minute), answers on the issue, and starts the build itself. The
 * result comes as the usual build issue, with Keep, Undo and a rating from there too.
 *
 * Only replies from people with access to the private repo count, never the app's own posts.
 * A build from the phone has every rule a build from the PC has: a finished plan, the code folder,
 * the month's budget, the run limit, one build at a time, and the gatekeeper on every step.
 */
import type { WorkItem } from '@aip/memory';
import { GitHub, messagesRepo, type Comment, type Fetch } from './github.ts';
import { readBudget } from './budget.ts';
import { runCapUsd } from './build.ts';
import { formatCost } from './money.ts';
import { SIGNATURE, withItems } from './notify.ts';
import { getInterview, listProjects } from './projects.ts';
import type { AppSettings } from './settings.ts';

export const CONTROL_LABEL = 'aip-control';
export const CONTROL_TITLE = 'AI Prototype: start builds from here';

export type Command = { kind: 'build'; project: string; feature: string } | { kind: 'projects' } | { kind: 'help' } | { kind: 'unknown' };

/** First line only: "build club hr F-02", "projects", "help". */
export function parseCommand(body: string): Command {
  const first = (body.trim().split('\n')[0] ?? '').trim().replace(/[.!]+$/, '');
  const lower = first.toLowerCase();
  if (lower === 'projects' || lower === 'list') return { kind: 'projects' };
  if (lower === 'help' || lower === '?') return { kind: 'help' };
  const b = /^build\s+(.+?)\s+(f-\d{2,3})$/i.exec(first);
  if (b) return { kind: 'build', project: b[1]!.trim(), feature: b[2]!.toUpperCase() };
  return { kind: 'unknown' };
}

export const HELP = [
  'Reply here with one of these (only the first line counts):',
  '',
  '- **projects**: the plans that are ready to build, and their features.',
  '- **build** *project* *feature*: builds one feature, for example `build club-hr F-02`. It costs money; the reply says the most it can cost.',
  '- **help**: this list.',
  '',
  'The app reads replies while it’s open on your PC, about once a minute. The result comes as a new issue, where you can reply **keep**, **undo** or a rating from **1** to **5**.',
].join('\n');

/** Sets up the control issue once; later calls give back the same one. */
export async function setupPhone(settings: AppSettings, dbPath: string, token: string, now: Date, fetchImpl?: Fetch): Promise<{ issue: number; url: string; summary: string }> {
  const existing = await withItems(dbPath, (w) => w.control());
  if (existing && existing.issue > 0) {
    return { issue: existing.issue, url: existing.issueUrl, summary: `Already set up: issue #${existing.issue}. Reply there from your phone.` };
  }
  const gh = new GitHub(token, await messagesRepo(settings), fetchImpl);
  const issue = await gh.createIssue(CONTROL_TITLE, `${HELP}\n\n${SIGNATURE}`, [CONTROL_LABEL]);
  const id = existing?.id ?? (await withItems(dbPath, (w) => w.add(now, 'control', 0, CONTROL_TITLE)));
  await withItems(dbPath, (w) => w.posted(id, issue.number, issue.url, now));
  return { issue: issue.number, url: issue.url, summary: `Set up: issue #${issue.number} on ${gh.repo}. Reply there from your phone with “projects” or “build <project> <feature>”.` };
}

/** A build the phone asked for, checked and ready to start. */
export interface BuildRequest { slug: string; feature: string; issue: number }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

async function projectsText(settings: AppSettings): Promise<string> {
  const ready = (await listProjects(settings)).filter((p) => p.finished);
  if (!ready.length) return 'No plan is finished yet. Finish a plan interview on the PC first.';
  const lines: string[] = ['Ready to build:'];
  for (const p of ready) {
    const { interview } = await getInterview(settings, p.slug);
    lines.push(`- **${p.name}** (\`${p.slug}\`): ${interview.features.map((f) => `${f.id} ${f.name}`).join(', ') || 'no features'}`);
  }
  return lines.join('\n');
}

/** Checks a build command against the same rules as the Build button. Throws plain words. */
async function checkBuild(settings: AppSettings, dbPath: string, cmd: { project: string; feature: string }, busy: boolean, now: Date): Promise<{ slug: string; feature: string; text: string }> {
  if (busy) throw new Error('A build is already running. Try again when it’s finished.');
  const ready = (await listProjects(settings)).filter((p) => p.finished);
  const p = ready.find((x) => x.slug === cmd.project.toLowerCase() || norm(x.name) === norm(cmd.project) || x.slug === norm(cmd.project));
  if (!p) throw new Error(`There’s no finished plan called “${cmd.project}”. Reply **projects** to see them.`);
  const { interview } = await getInterview(settings, p.slug);
  const f = interview.features.find((x) => x.id === cmd.feature);
  if (!f) throw new Error(`${p.name} has no feature ${cmd.feature}. Reply **projects** to see them.`);
  if (!settings.codeFolders[p.slug]) throw new Error(`${p.name} has no code folder on this computer yet. Set it on the PC first.`);
  const b = await readBudget(dbPath, settings, now);
  if (b.leftUsd <= 0) throw new Error(`This month’s budget is used up (£${b.spentGbp} of £${b.budgetGbp}). Raise it in Settings on the PC, or wait until next month.`);
  const most = formatCost(runCapUsd(settings, b.leftUsd), settings.gbpPerUsd);
  return { slug: p.slug, feature: f.id, text: `Starting ${f.id} ${f.name} in ${p.name}. It costs up to ${most}. The result comes as a new issue.` };
}

export interface ControlResult { done: string[]; builds: BuildRequest[] }

/** Reads new replies on the control issue, answers each, and gives back at most one build to start. */
export async function answerControl(
  item: WorkItem,
  gh: GitHub,
  settings: AppSettings,
  dbPath: string,
  now: () => Date,
  busy: boolean,
  fromJoshua: (c: Comment) => boolean,
): Promise<ControlResult> {
  const out: ControlResult = { done: [], builds: [] };
  const since = item.readUpTo ?? item.at;
  const replies = (await gh.comments(item.issue, since)).filter((c) => c.at > since && fromJoshua(c));
  for (const c of replies) {
    const cmd = parseCommand(c.body);
    let text: string;
    try {
      if (cmd.kind === 'projects') text = await projectsText(settings);
      else if (cmd.kind === 'help') text = HELP;
      else if (cmd.kind === 'build') {
        const r = await checkBuild(settings, dbPath, cmd, busy || out.builds.length > 0, now());
        out.builds.push({ slug: r.slug, feature: r.feature, issue: item.issue });
        text = r.text;
      } else text = `Sorry, I didn’t understand that.\n\n${HELP}`;
    } catch (err) {
      text = (err as Error).message;
    }
    await gh.comment(item.issue, `${text}\n\n${SIGNATURE}`);
    out.done.push(`From your phone (issue #${item.issue}): ${text.split('\n')[0]}`);
    await withItems(dbPath, (w) => w.readTo(item.id, c.at));
  }
  return out;
}

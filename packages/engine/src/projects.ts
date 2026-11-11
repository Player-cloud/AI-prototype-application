/**
 * Projects and their plan interviews, kept in the data repo's projects/<slug>/ folder.
 * Answers are saved to interview.json as joshua goes; finishing the interview writes spec.md and
 * the done files, then syncs the data repo (a failed sync keeps everything saved here).
 */
import type { AppSettings } from './settings.ts';
import { askCostNote } from './budget.ts';
import { renderReview, reviewersFor, type Finding } from './review.ts';
import {
  CHECKLIST_AREAS,
  STAGES,
  applyPatch,
  bigBuild,
  checkInterview,
  confirmStage,
  finished,
  missing,
  newInterview,
  projectStatus,
  renderSpec,
  reviewCurrent,
  specHash,
  stageOf,
  toolsForStage,
  type Interview,
  type InterviewPatch,
  type StageId,
  type ToolHint,
} from './interview.ts';

function folderOf(settings: AppSettings): string {
  if (!settings.dataFolder) throw new Error('Set your data folder in Settings first.');
  return settings.dataFolder;
}

export interface ProjectRow { slug: string; name: string; status: string; finished: boolean; updatedAt: string }

/** What the screen shows for one interview. */
export interface InterviewView {
  interview: Interview;
  /** What's still needed to confirm the stage on screen. */
  missing: string[];
  /** Tools related to the stage on screen. */
  tools: ToolHint[];
  big: boolean;
  finished: boolean;
  /** Shown on the "Ask Claude" button, e.g. "costs up to £0.40 ($0.50)". */
  askCost: string;
  /** How many reviewers the plan gets (1, or 3 fresh-eyes for a big build), and the most it costs. */
  reviewers: number;
  reviewCost: string;
  /** True when the last review looked at the spec as it is now. */
  reviewCurrent: boolean;
}

export const interviewStages = () => ({ stages: STAGES, areas: CHECKLIST_AREAS });

async function load(folder: string, slug: string): Promise<Interview> {
  const m = await import('@aip/memory');
  const raw = await m.readProjectJson(folder, slug);
  if (raw === null) throw new Error(`There’s no project called “${slug}”.`);
  return checkInterview(raw);
}

async function save(folder: string, iv: Interview, extra: Record<string, string> = {}): Promise<string[]> {
  const m = await import('@aip/memory');
  const text = JSON.stringify(iv, null, 2);
  for (const t of [text, ...Object.values(extra)]) {
    if (m.looksLikeKey(t)) throw new Error('That looks like a key. Keys go only in Settings, never in a plan.');
  }
  return m.writeProjectFiles(folder, iv.slug, { 'interview.json': `${text}\n`, ...extra });
}

async function view(settings: AppSettings, folder: string, iv: Interview, stage: StageId = iv.current): Promise<InterviewView> {
  const m = await import('@aip/memory');
  let tools: ToolHint[] = [];
  try {
    tools = toolsForStage(stage, (await m.loadDataRepo(folder)).tools);
  } catch {
    // no ledger: the interview still works, just without tool hints
  }
  const reviewers = reviewersFor(bigBuild(iv)).length;
  return {
    interview: iv,
    missing: missing(iv, stage),
    tools,
    big: bigBuild(iv),
    finished: finished(iv),
    askCost: askCostNote(settings),
    reviewers,
    reviewCost: askCostNote(settings, reviewers),
    reviewCurrent: reviewCurrent(iv),
  };
}

export async function listProjects(settings: AppSettings): Promise<ProjectRow[]> {
  const folder = folderOf(settings);
  const m = await import('@aip/memory');
  const rows: ProjectRow[] = [];
  for (const slug of await m.listProjectSlugs(folder)) {
    try {
      const iv = checkInterview(await m.readProjectJson(folder, slug));
      rows.push({ slug, name: iv.name, status: projectStatus(iv), finished: finished(iv), updatedAt: iv.updatedAt });
    } catch {
      rows.push({ slug, name: slug, status: 'interview.json is damaged', finished: false, updatedAt: '' });
    }
  }
  return rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function startInterview(settings: AppSettings, name: unknown, now: Date): Promise<InterviewView> {
  const folder = folderOf(settings);
  const m = await import('@aip/memory');
  if (typeof name !== 'string' || !name.trim()) throw new Error('Give the project a name.');
  const slug = m.slugify(name);
  if (!slug) throw new Error('Use some letters or numbers in the project name.');
  if ((await m.readProjectJson(folder, slug)) !== null) throw new Error(`There’s already a project called “${slug}”. Open it from the list.`);
  const iv = newInterview(name, slug, now);
  await save(folder, iv);
  return view(settings, folder, iv);
}

export async function getInterview(settings: AppSettings, slug: string, stage?: string): Promise<InterviewView> {
  const folder = folderOf(settings);
  const iv = await load(folder, slug);
  return view(settings, folder, iv, stage ? stageOf(stage).id : iv.current);
}

/** Saves answers without confirming anything. `stage` is the stage on screen. */
export async function saveAnswers(settings: AppSettings, slug: string, patch: InterviewPatch, stage: string | undefined, now: Date) {
  const folder = folderOf(settings);
  const iv = { ...applyPatch(await load(folder, slug), patch), updatedAt: now.toISOString() };
  await save(folder, iv);
  return view(settings, folder, iv, stage ? stageOf(stage).id : iv.current);
}

/**
 * Confirms a stage. When every stage is confirmed, writes spec.md and the done files and syncs the
 * data repo. Returns the new view plus, when written, the files and a sync summary.
 */
export async function confirm(settings: AppSettings, slug: string, stage: string, now: Date) {
  const folder = folderOf(settings);
  let iv = confirmStage(await load(folder, slug), stageOf(stage).id, now);
  if (!finished(iv)) {
    await save(folder, iv);
    return { view: await view(settings, folder, iv), files: [] as string[], summary: `${stageOf(stage).title}: confirmed.` };
  }
  iv = { ...iv, specAt: now.toISOString() };
  const files = await save(folder, iv, renderSpec(iv, now));
  const m = await import('@aip/memory');
  let synced: string;
  try {
    synced = (await m.syncDataRepo(folder, `Plan ${iv.name}: spec with ${iv.features.length} features`)).summary;
  } catch (err) {
    synced = `Saved here, but not synced yet: ${(err as Error).message}`;
  }
  return {
    view: await view(settings, folder, iv),
    files,
    summary: `Spec written: ${iv.features.length} feature${iv.features.length === 1 ? '' : 's'}, each with a done file. ${synced}`,
  };
}

/** Saves a finished plan review as review.md (and in interview.json), then syncs. */
export async function recordReview(settings: AppSettings, iv: Interview, findings: Finding[], costText: string, now: Date) {
  const folder = folderOf(settings);
  if (!iv.specAt) throw new Error('Finish the interview first: the review reads the spec.');
  const big = bigBuild(iv);
  const next: Interview = { ...iv, review: { at: now.toISOString(), specHash: specHash(iv), big, findings, costText } };
  await save(folder, next, { 'review.md': renderReview(next, findings, big, costText, now) });
  const m = await import('@aip/memory');
  let synced: string;
  try {
    synced = (await m.syncDataRepo(folder, `Plan review for ${iv.name}`)).summary;
  } catch (err) {
    synced = `Saved here, but not synced yet: ${(err as Error).message}`;
  }
  const must = findings.filter((f) => f.severity === 'must').length;
  return {
    view: await view(settings, folder, next),
    summary: `${findings.length ? `${findings.length} finding${findings.length === 1 ? '' : 's'}${must ? `, ${must} must fix` : ''}` : 'No problems found'}. Cost: ${costText}. ${synced}`,
  };
}

/** The interview, checked as finished, for a review. */
export async function interviewForReview(settings: AppSettings, slug: string): Promise<Interview> {
  const iv = await load(folderOf(settings), slug);
  if (!finished(iv) || !iv.specAt) throw new Error('Finish the interview first: the review reads the spec.');
  return iv;
}

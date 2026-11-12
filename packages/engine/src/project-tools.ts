/**
 * CI-7 (SUP-H, SUP-G): each project's approved tools and own rules, and a free read of the
 * written instructions for ones that are out of date or clash.
 *
 * The app only suggests tools for a project; joshua's choice is what's saved. Once he has chosen,
 * builds for that project only use a build model on the list. The free checks (secret scan,
 * package audit, checklist, pictures) always run whatever the list says: a safety check is never
 * switched off by a project.
 */
import { join } from 'node:path';
import type { AppSettings } from './settings.ts';
import { fileChanged } from './history.ts';
import { getInterview } from './projects.ts';

export interface ProjectToolRow {
  id: string;
  name: string;
  kind: string;
  /** Whether the app suggests it for this project, and why (or why not). */
  suggested: boolean;
  why: string;
  approved: boolean;
}

export interface ProjectTools {
  slug: string;
  /** null until joshua has chosen; until then the project uses the general tools. */
  approved: string[] | null;
  rows: ProjectToolRow[];
  /** This project's own rules (projects/<slug>/rules.md). */
  rules: string[];
}

/** Checklist areas that make a tool worth having for a project. */
const AREA_TOOLS: Record<string, string> = { 'axe-core': 'Accessibility' };

function folderOf(settings: AppSettings): string {
  if (!settings.dataFolder) throw new Error('Set your data folder in Settings first.');
  return settings.dataFolder;
}

export async function projectTools(settings: AppSettings, slug: string): Promise<ProjectTools> {
  const folder = folderOf(settings);
  const m = await import('@aip/memory');
  const { interview } = await getInterview(settings, slug);
  const repo = await m.loadDataRepo(folder);
  const health = await m.listHealth(folder);
  const approved = await m.readProjectTools(folder, slug);
  const rows: ProjectToolRow[] = repo.tools.map((t) => {
    const h = health.get(t.id);
    const area = AREA_TOOLS[t.id];
    let suggested = false;
    let why: string;
    if (h?.off) why = `Switched off: ${h.off.reason}`;
    else if (t.state === 'off') why = `${t.status.split(/[.:—-]/)[0]!.trim() || 'Off'} in the ledger.`;
    else if (t.state === 'untested') why = 'Not tested yet, so not suggested.';
    else if (t.state === 'trial') why = 'Waiting for a trial, so not suggested yet.';
    else if (t.state !== 'on') why = 'Its ledger status isn’t clear.';
    else if (area && !interview.areas.includes(area)) why = `This project doesn’t check ${area}.`;
    else {
      suggested = true;
      why = area ? `On, and this project checks ${area}.` : t.job.trim() && t.job.trim() !== '-' ? `On for “${t.job.trim()}”.` : 'On in the ledger.';
    }
    return { id: t.id, name: t.name, kind: t.card?.kind ?? 'unknown', suggested, why, approved: approved?.includes(t.id) ?? false };
  });
  return { slug, approved, rows, rules: await m.readProjectRules(folder, slug) };
}

/**
 * Saves joshua's choice of tools for a project. Only tools the data folder knows can be chosen.
 * Kept in the history so it can be undone, then synced.
 */
export async function approveProjectTools(settings: AppSettings, slug: string, tools: unknown, dbPath: string | null, now: Date) {
  const folder = folderOf(settings);
  if (!Array.isArray(tools) || tools.some((t) => typeof t !== 'string')) throw new Error('Pick the tools as a list.');
  const m = await import('@aip/memory');
  await getInterview(settings, slug); // the project must exist
  const repo = await m.loadDataRepo(folder);
  const known = new Set([...repo.tools.map((t) => t.id), ...(await m.listHealth(folder)).keys()]);
  const unknown = (tools as string[]).filter((t) => !known.has(t));
  if (unknown.length) throw new Error(`Not in your tools: ${unknown.join(', ')}`);
  const path = join(folder, 'projects', slug, 'tools.md');
  const { readFile } = await import('node:fs/promises');
  const before = await readFile(path, 'utf8').catch(() => '');
  await m.writeProjectTools(folder, slug, tools as string[]);
  const count = new Set(tools as string[]).size;
  const label = `Approved ${count} tool${count === 1 ? '' : 's'} for ${slug}`;
  if (dbPath) await fileChanged(dbPath, path, before, await readFile(path, 'utf8'), label, now);
  let synced: string;
  try {
    synced = (await m.syncDataRepo(folder, label)).summary;
  } catch (err) {
    synced = `Saved here, but not synced yet: ${(err as Error).message}`;
  }
  return { ...(await projectTools(settings, slug)), summary: `${label}.`, synced };
}

/**
 * Before a build: once joshua has chosen tools for the project, the build model must be on the
 * list. Returns a plain-words reason to stop, or null to go ahead.
 */
export async function notApproved(settings: AppSettings, slug: string, toolId: string, toolName: string): Promise<string | null> {
  if (!settings.dataFolder) return null;
  const m = await import('@aip/memory');
  const approved = await m.readProjectTools(settings.dataFolder, slug);
  if (approved === null || approved.includes(toolId)) return null;
  return `${toolName} isn’t approved for ${slug}. Approve it in Projects → Tools for this project, or choose another model in Settings.`;
}

/** This project's rules for the build prompt. They beat the general rules and habits here. */
export async function projectGuidance(settings: AppSettings, slug: string): Promise<string> {
  if (!settings.dataFolder) return '';
  const m = await import('@aip/memory');
  const rules = await m.readProjectRules(settings.dataFolder, slug);
  if (!rules.length) return '';
  return ['', 'Rules for this project (these beat the general rules and habits):', ...rules.map((r) => `- ${r}`)].join('\n');
}

/**
 * SUP-G: reads rules.md, habits.md, each project's rules.md and the tool cards for instructions
 * that are out of date or clash. Free and local; changes nothing.
 */
export async function docIssues(settings: AppSettings): Promise<string[]> {
  if (!settings.dataFolder) return [];
  const folder = settings.dataFolder;
  const m = await import('@aip/memory');
  const { readFile, readdir } = await import('node:fs/promises');
  const read = (f: string) => readFile(join(folder, f), 'utf8').catch(() => '');
  const sources: import('@aip/memory').DocSource[] = [
    { file: 'rules.md', lines: m.bulletLines(await read('rules.md')) },
    { file: 'habits.md', lines: m.bulletLines(await read('habits.md')) },
  ];
  const cards = (await readdir(join(folder, 'tools')).catch(() => [] as string[])).filter((f) => f.endsWith('.md')).sort();
  for (const f of cards) sources.push({ file: `tools/${f}`, lines: m.cardLines(await read(join('tools', f))) });
  const repo = await m.loadDataRepo(folder);
  const health = await m.listHealth(folder);
  const tools = repo.tools.map((t) => ({
    id: t.id,
    names: [...new Set([t.name, t.id, t.card?.title ?? '', t.card?.ledger ?? ''].filter(Boolean))],
    cardFile: t.card ? `tools/${t.card.name}.md` : null,
    cardVersion: t.card?.version ?? '',
    inUse: health.get(t.id)?.version ?? null,
    off: t.state === 'off' || !!health.get(t.id)?.off,
  }));
  const issues = m.checkDocs(sources, tools);
  // Each project is read on its own: its rules may override the general ones (that's allowed),
  // but they shouldn't clash with each other, or rely on old versions or switched-off tools.
  for (const slug of await m.listProjectSlugs(folder)) {
    const file = `projects/${slug}/rules.md`;
    const lines = m.bulletLines(await read(file));
    if (lines.length) issues.push(...m.checkDocs([{ file, lines }], tools.map((t) => ({ ...t, cardFile: null, cardVersion: '' }))));
  }
  return issues.map(m.docIssueText);
}

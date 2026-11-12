/**
 * The Capability Centre (UI-01): one place that shows every capability's lifecycle, test results,
 * real-build evidence, computers and health, plus comparisons and recommendations.
 *
 * Every number comes from a real record (ledger, tool health, free test results, build runs,
 * updates). Where there's no record it says "Not tested" or "No builds yet", never 0. Scores
 * stay separate: nothing is added up into one grade, and joshua's rating is kept apart.
 * Recommendations only point at a next step; the Centre changes nothing.
 */
import type { AppSettings } from './settings.ts';
import { dataOverview, type ToolRow } from './data.ts';
import { ENOUGH_BUILDS, compareWorkflows, workflowAdvice, type WorkflowRow } from './workflows.ts';

/** SUP-E lifecycle states, as far as the records show them. */
export type Lifecycle = 'in use' | 'stale' | 'switched off' | 'retired' | 'on trial' | 'not tested';
export const LIFECYCLES: readonly Lifecycle[] = ['in use', 'stale', 'on trial', 'not tested', 'switched off', 'retired'];

export interface CentreRow {
  id: string;
  name: string;
  kind: string;
  version: string | null;
  lifecycle: Lifecycle;
  /** Why it's in that state, in plain words. */
  why: string;
  /** Free test results ('Not tested' when there are none). */
  tests: string;
  /** A test that did worse after an update ('' when none). */
  regression: string;
  /** Real builds with it as the build model ('' when it isn't one, 'No builds yet' when none). */
  builds: string;
  computers: string;
  health: string;
  /** joshua's rating, kept apart from everything else. */
  rating: string;
}

export type Centre =
  | { configured: false }
  | {
      configured: true;
      rows: CentreRow[];
      counts: Record<Lifecycle, number>;
      /** Ways of building compared on real builds (CI-4). */
      comparisons: string[];
      /** Next steps the records point to. Nothing is done until joshua does it. */
      recommendations: string[];
    };

export function lifecycleOf(t: Pick<ToolRow, 'state' | 'stale' | 'switchedOff' | 'status'>): { lifecycle: Lifecycle; why: string } {
  if (t.switchedOff) return { lifecycle: 'switched off', why: 'Switched off after failing 3 times in a row. Switch it back on in Tools.' };
  if (t.state === 'off') return { lifecycle: 'retired', why: `Ledger: ${t.status}` };
  if (t.state === 'untested') return { lifecycle: 'not tested', why: 'In the ledger, not tested yet.' };
  if (t.state === 'trial') return { lifecycle: 'on trial', why: 'Waiting for a trial.' };
  if (t.state === 'on' && t.stale) return { lifecycle: 'stale', why: 'Changed since its evidence was gathered: retested on next use.' };
  if (t.state === 'on') return { lifecycle: 'in use', why: `Ledger: ${t.status}` };
  return { lifecycle: 'not tested', why: t.status ? `Ledger status unclear: ${t.status}` : 'Not in the ledger yet.' };
}

export async function capabilityCentre(
  settings: AppSettings,
  opts: { dbPath?: string | null; nameOf: (id: string) => Promise<string>; buildModel?: string | null },
): Promise<Centre> {
  const o = await dataOverview(settings);
  if (!o.configured) return { configured: false };
  const m = await import('@aip/memory');
  let workflows: WorkflowRow[] = [];
  if (opts.dbPath) {
    try {
      workflows = await compareWorkflows(settings, opts.dbPath, opts.nameOf);
    } catch {
      // no build history on this computer yet
    }
  }
  const repo = await m.loadDataRepo(settings.dataFolder);
  const byId = new Map<string, WorkflowRow>();
  for (const w of workflows) byId.set(m.toolIdFor(repo.tools, w.name), w);

  const rows: CentreRow[] = o.tools.map((t) => {
    const { lifecycle, why } = lifecycleOf(t);
    const w = byId.get(t.id);
    return {
      id: t.id,
      name: t.name,
      kind: t.kind,
      version: t.version,
      lifecycle,
      why,
      tests: t.tested || (t.testable ? 'Not tested yet: it has a free test in Tools.' : 'Not tested: no free test for it yet.'),
      regression: t.regression,
      builds: w ? w.text : t.kind === 'model' ? 'No builds yet.' : '',
      computers: t.byComputer,
      health: t.health,
      rating: t.rating && t.rating !== '-' ? `${t.rating} / 5` : 'Not rated',
    };
  });
  // A build model with builds but no ledger line or health record still shows.
  for (const [id, w] of byId) {
    if (rows.some((r) => r.id === id)) continue;
    rows.push({ id, name: w.name, kind: 'model', version: w.model, lifecycle: 'in use', why: 'Used for builds; not in the ledger yet.', tests: 'Not tested: no free test for it yet.', regression: '', builds: w.text, computers: '', health: '', rating: 'Not rated' });
  }

  const counts = Object.fromEntries(LIFECYCLES.map((l) => [l, rows.filter((r) => r.lifecycle === l).length])) as Record<Lifecycle, number>;

  const recs: string[] = [];
  for (const r of rows) if (r.regression) recs.push(`${r.name}: ${r.regression}`);
  for (const u of o.updates.filter((x) => x.status === 'installed' && x.check?.outcome === 'worse')) recs.push(`${u.package} ${u.to} did worse after the update. Tools → Updates shows the command to go back.`);
  for (const t of o.tools.filter((x) => x.switchedOff)) recs.push(`${t.name} is switched off. Switch it back on in Tools when it’s fixed, or leave it off.`);
  for (const t of o.tools.filter((x) => x.stale && !x.switchedOff)) recs.push(`${t.name} changed since it was tested.${t.testable ? ' Run its free test in Tools.' : ' It’s retested next time it’s used.'}`);
  for (const t of o.tools.filter((x) => x.testable && !x.tested)) recs.push(`${t.name} has a free test but no results yet. Run it in Tools (free).`);
  const waiting = o.updates.filter((u) => u.status === 'found').length;
  if (waiting) recs.push(`${waiting} update${waiting === 1 ? '' : 's'} waiting for your OK in Tools → Updates.`);
  if (o.docIssues.length) recs.push(`${o.docIssues.length} instruction${o.docIssues.length === 1 ? '' : 's'} to check in Tools (out of date or clashing).`);
  recs.push(...o.clashes);
  if (opts.buildModel) {
    const stats = workflows;
    const names = new Map(workflows.map((w) => [w.model, w.name]));
    const nameOf = (id: string) => names.get(id) ?? id;
    recs.push(...workflowAdvice(opts.buildModel, stats, nameOf, settings.gbpPerUsd).filter((l) => l.startsWith('Suggestion:')));
  }

  const comparisons = workflows.length
    ? [
        ...workflows.map((w) => w.text),
        ...(workflows.filter((w) => w.finished >= ENOUGH_BUILDS).length < 2 ? [`To compare ways of building fairly, each needs at least ${ENOUGH_BUILDS} kept or undone builds.`] : []),
      ]
    : [opts.dbPath ? 'No builds on this computer yet, so there’s nothing to compare.' : 'Build history isn’t available here.'];

  return { configured: true, rows, counts, comparisons, recommendations: [...new Set(recs)] };
}

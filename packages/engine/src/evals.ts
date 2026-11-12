/**
 * CI-3: runs the free repeatable tests (planted problems each tool must find), saves the results
 * in the data repo, and counts each passed or failed run in the tool's health record, so a pass
 * clears an out-of-date mark (D-2). A blocked test (no browser, say) records nothing: it's not a
 * failure of the tool. Paid model tests aren't run from here.
 */
import type { EvalResult } from '@aip/checks';
import type { AppSettings } from './settings.ts';

export interface EvalReport {
  results: { capability: string; suite: string; outcome: EvalResult['outcome']; detail: string }[];
  /** Plain words for the screen. */
  summary: string;
  synced: string;
}

const detailOf = (r: EvalResult) =>
  r.outcome === 'passed'
    ? `${r.cases.length} of ${r.cases.length} cases right`
    : r.cases
        .filter((c) => c.outcome !== 'passed')
        .map((c) => `${c.name}: ${c.detail}`)
        .join('; ');

export async function runFreeTests(
  settings: AppSettings,
  opts: { capability?: string; now?: Date; run?: (suites: readonly import('@aip/checks').EvalSuite[]) => Promise<EvalResult[]> } = {},
): Promise<EvalReport> {
  const c = await import('@aip/checks');
  const suites = c.SUITES.filter((s) => s.free && (!opts.capability || s.capability === opts.capability));
  if (suites.length === 0) throw new Error(`There’s no free test for ${opts.capability} yet, so it stays untested.`);
  const now = opts.now ?? new Date();
  const results = await (opts.run ?? ((s) => c.runSuites(s, { now: () => now })))(suites);
  let synced = '';
  if (settings.dataFolder) {
    const m = await import('@aip/memory');
    const folder = settings.dataFolder;
    await m.addEvals(folder, results);
    let names = new Map<string, string>();
    try {
      names = new Map((await m.loadDataRepo(folder)).tools.map((t) => [t.id, t.name]));
    } catch {
      // no ledger: IDs stand in for names
    }
    for (const r of results) {
      if (r.outcome !== 'passed' && r.outcome !== 'failed') continue;
      const computer = r.environment.computer;
      const label = names.get(r.capability) ?? suites.find((x) => x.capability === r.capability)?.label ?? r.capability;
      let h = await m.readHealth(folder, label, r.capability);
      if (r.version) h = m.noteVersion(h, r.version, computer);
      h = m.recordRun(h, r.outcome === 'passed' ? { ok: true } : { ok: false, error: `Test ${r.suite} failed: ${detailOf(r)}` }, now, computer);
      await m.writeHealth(folder, h);
    }
    try {
      synced = (await m.syncDataRepo(folder, `Free tests on ${results[0]?.environment.computer ?? 'this computer'}`)).summary;
    } catch (err) {
      synced = `Saved here, but not synced yet: ${(err as Error).message}`;
    }
  }
  const count = (o: string) => results.filter((r) => r.outcome === o).length;
  const parts = [`${count('passed')} passed`, count('failed') && `${count('failed')} failed`, count('blocked') && `${count('blocked')} couldn’t run here`].filter(Boolean);
  return {
    results: results.map((r) => ({ capability: r.capability, suite: r.suite, outcome: r.outcome, detail: detailOf(r) })),
    summary: `Free tests: ${parts.join(', ')} (of ${results.length}). Cost: £0.00 ($0.00).`,
    synced,
  };
}

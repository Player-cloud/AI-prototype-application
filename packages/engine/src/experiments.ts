/**
 * CI-5: a controlled experiment, free. Question: does this tool give the same answer every time on
 * this computer? Fixed inputs: its planted-problem test, run several times in a row. Measures: the
 * outcome and cases right each run, and the time. The result is saved as a proposal in the data
 * repo; nothing changes because of it (no health marks, no switching off) until joshua adopts it.
 */
import type { EvalResult, EvalSuite } from '@aip/checks';
import type { Experiment } from '@aip/memory';
import type { AppSettings } from './settings.ts';

export const DEFAULT_RUNS = 3;
export const MAX_RUNS = 10;

export interface ExperimentReport {
  experiments: Pick<Experiment, 'id' | 'capability' | 'question' | 'verdict' | 'at' | 'status'>[];
  summary: string;
  synced: string;
}

const right = (r: EvalResult) => `${r.cases.filter((c) => c.outcome === 'passed').length}/${r.cases.length}`;
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** What the runs say, in plain words. */
export function verdictOf(runs: EvalResult[]): string {
  const n = runs.length;
  const blocked = runs.filter((r) => r.outcome === 'blocked' || r.outcome === 'not run').length;
  if (blocked) return `Couldn’t run here in ${blocked} of ${n} runs, so this says nothing yet.`;
  const seen = new Set(runs.map((r) => `${r.outcome} ${right(r)}`));
  if (seen.size === 1) return `Steady: ${runs[0]!.outcome} in all ${n} runs (${right(runs[0]!)} cases right each time).`;
  return `Unsteady: the same test gave different results (${runs.map((r) => `${r.outcome} ${right(r)}`).join(', ')}). Treat this tool’s results with care until it’s looked at.`;
}

export async function runRepeatExperiment(
  settings: AppSettings,
  opts: { capability: string; runs?: number; now?: () => Date; run?: (suites: readonly EvalSuite[]) => Promise<EvalResult[]> },
): Promise<ExperimentReport> {
  const c = await import('@aip/checks');
  const suites = c.SUITES.filter((s) => s.free && s.capability === opts.capability);
  if (suites.length === 0) throw new Error(`There’s no free test for ${opts.capability} yet, so there’s nothing to experiment with.`);
  const runs = opts.runs ?? DEFAULT_RUNS;
  if (!Number.isInteger(runs) || runs < 2 || runs > MAX_RUNS) throw new Error(`Runs must be a whole number from 2 to ${MAX_RUNS}.`);
  const now = opts.now ?? (() => new Date());
  const runOnce = opts.run ?? ((s) => c.runSuites(s, { now }));
  const bySuite = new Map<string, EvalResult[]>();
  for (let i = 0; i < runs; i += 1) for (const r of await runOnce(suites)) bySuite.set(r.suite, [...(bySuite.get(r.suite) ?? []), r]);
  const at = now();
  const experiments: Experiment[] = [...bySuite].map(([suite, rs]) => ({
    id: `${stamp(at)}-${suite}-repeat`,
    question: `Does ${suites.find((s) => s.id === suite)?.label ?? opts.capability} give the same answer every time on this computer?`,
    capability: opts.capability,
    inputs: { suite, runs },
    measures: ['outcome each run', 'cases right each run', 'time each run'],
    result: {
      outcomes: rs.map((r) => r.outcome),
      passedRuns: rs.filter((r) => r.outcome === 'passed').length,
      casesRight: rs.map(right),
      msMin: Math.min(...rs.map((r) => r.ms)),
      msMax: Math.max(...rs.map((r) => r.ms)),
      version: rs.at(-1)?.version ?? '',
    },
    verdict: verdictOf(rs),
    status: 'proposal',
    environment: rs[0]!.environment,
    at: at.toISOString(),
    costUsd: 0,
  }));
  let synced = '';
  if (settings.dataFolder) {
    const m = await import('@aip/memory');
    for (const e of experiments) await m.saveExperiment(settings.dataFolder, e);
    try {
      synced = (await m.syncDataRepo(settings.dataFolder, `Experiment on ${opts.capability}`)).summary;
    } catch (err) {
      synced = `Saved here, but not synced yet: ${(err as Error).message}`;
    }
  }
  return {
    experiments: experiments.map(({ id, capability, question, verdict, at: when, status }) => ({ id, capability, question, verdict, at: when, status })),
    summary: `${experiments.map((e) => e.verdict).join(' ')} Nothing was changed: it’s a proposal. Cost: £0.00 ($0.00).`,
    synced,
  };
}

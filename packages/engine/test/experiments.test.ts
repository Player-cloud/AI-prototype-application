import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EvalResult, EvalSuite } from '@aip/checks';
import { readHealth } from '@aip/memory';
import { runRepeatExperiment, verdictOf } from '../src/experiments.ts';
import { runFreeTests } from '../src/evals.ts';
import { checkSettings } from '../src/settings.ts';
import { handleLine } from '../src/protocol.ts';

const NOW = new Date('2026-11-12T11:00:00Z');

const res = (outcome: EvalResult['outcome'], right = 4, ms = 10, version = '11.2.5'): EvalResult => ({
  suite: 'secretlint-planted',
  capability: 'secretlint',
  kind: 'tool',
  outcome,
  cases: Array.from({ length: 4 }, (_, i) => ({ name: `c${i}`, outcome: i < right ? 'passed' : 'failed', detail: '' })),
  version,
  environment: { computer: 'lapto', os: 'Windows', node: '22.12.0' },
  at: NOW.toISOString(),
  ms,
  costUsd: 0,
});

/** Gives back the planned results one run at a time. */
const planned = (rs: EvalResult[]) => {
  let i = 0;
  return async (_s: readonly EvalSuite[]) => [rs[i++]!];
};

describe('experiments (CI-5)', () => {
  let data = '';
  beforeEach(async () => {
    data = await mkdtemp(join(tmpdir(), 'aip-exprun-'));
    await writeFile(join(data, 'ledger.md'), '- secretlint | ON | secret scan | x\n');
  });
  afterEach(async () => {
    await rm(data, { recursive: true, force: true });
  });

  it('says whether a tool is steady, unsteady, or couldn’t run', () => {
    expect(verdictOf([res('passed'), res('passed'), res('passed')])).toBe('Steady: passed in all 3 runs (4/4 cases right each time).');
    expect(verdictOf([res('passed'), res('failed', 3), res('passed')])).toBe(
      'Unsteady: the same test gave different results (passed 4/4, failed 3/4, passed 4/4). Treat this tool’s results with care until it’s looked at.',
    );
    expect(verdictOf([res('passed'), res('blocked', 0)])).toBe('Couldn’t run here in 1 of 2 runs, so this says nothing yet.');
  });

  it('saves the question, fixed inputs, measures and result as a proposal, and changes nothing else', async () => {
    const r = await runRepeatExperiment(checkSettings({ dataFolder: data }), { capability: 'secretlint', now: () => NOW, run: planned([res('passed', 4, 5), res('failed', 3, 9), res('passed', 4, 7)]) });
    expect(r.summary).toMatch(/^Unsteady: .* Nothing was changed: it’s a proposal\. Cost: £0\.00 \(\$0\.00\)\.$/);
    expect(r.synced).toMatch(/^Saved here, but not synced yet/);
    expect(r.experiments).toMatchObject([{ id: '20261112-110000-secretlint-planted-repeat', capability: 'secretlint', status: 'proposal' }]);
    const saved = JSON.parse(await readFile(join(data, 'experiments', '20261112-110000-secretlint-planted-repeat.json'), 'utf8'));
    expect(saved).toMatchObject({
      question: 'Does secretlint give the same answer every time on this computer?',
      inputs: { suite: 'secretlint-planted', runs: 3 },
      measures: ['outcome each run', 'cases right each run', 'time each run'],
      result: { outcomes: ['passed', 'failed', 'passed'], passedRuns: 2, casesRight: ['4/4', '3/4', '4/4'], msMin: 5, msMax: 9, version: '11.2.5' },
      costUsd: 0,
    });
    // No health marks and no test results come from an experiment.
    expect((await readHealth(data, 'secretlint')).consecutiveFailures).toBe(0);
    await expect(readdir(join(data, 'evaluations'))).rejects.toThrow();
  });

  it('refuses a tool with no test and silly run counts, plainly', async () => {
    await expect(runRepeatExperiment(checkSettings({}), { capability: 'egm' })).rejects.toThrow('There’s no free test for egm yet, so there’s nothing to experiment with.');
    await expect(runRepeatExperiment(checkSettings({}), { capability: 'secretlint', runs: 1 })).rejects.toThrow('Runs must be a whole number from 2 to 10.');
    const out = JSON.parse((await handleLine(JSON.stringify({ id: 1, method: 'experiment_run', params: { settings: {}, capability: 'secretlint', runs: 99 } })))!);
    expect(out.error).toContain('Runs must be a whole number from 2 to 10.');
  });

  it('free tests report a tool that got worse after an update, and the Tools page shows it', async () => {
    const settings = checkSettings({ dataFolder: data });
    const only = (r: EvalResult) => async (s: readonly EvalSuite[]) => s.map((x) => ({ ...r, suite: x.id, capability: x.capability }));
    await runFreeTests(settings, { capability: 'secretlint', now: new Date('2026-11-11T00:00:00Z'), run: only(res('passed', 4, 5, '11.2.5')) });
    const r = await runFreeTests(settings, { capability: 'secretlint', now: NOW, run: only(res('failed', 3, 5, '11.3.0')) });
    expect(r.regressions).toEqual(['secretlint got worse after updating from 11.2.5 to 11.3.0 on lapto (secretlint-planted): passed (4/4) before, failed (3/4) now.']);
    await runRepeatExperiment(settings, { capability: 'secretlint', now: () => NOW, run: planned([res('passed'), res('passed')]), runs: 2 });
    const o = JSON.parse((await handleLine(JSON.stringify({ id: 2, method: 'data_overview', params: { settings: { dataFolder: data } } })))!).result;
    const t = o.tools.find((x: { id: string }) => x.id === 'secretlint');
    expect(t.regression).toMatch(/^Got worse after updating from 11\.2\.5 to 11\.3\.0/);
    expect(t.testable).toBe(true);
    expect(o.experiments).toMatchObject([{ capability: 'secretlint', verdict: 'Steady: passed in all 2 runs (4/4 cases right each time).', status: 'proposal' }]);
  });
});

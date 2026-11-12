import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRegressions, listExperiments, regressionNote, saveExperiment, type Experiment, type StoredEval } from '../src/index.ts';

const result = (version: string, right: number, at: string, extra: Partial<StoredEval> = {}): StoredEval => ({
  suite: 'secretlint-planted',
  capability: 'secretlint',
  kind: 'tool',
  outcome: right === 4 ? 'passed' : 'failed',
  cases: Array.from({ length: 4 }, (_, i) => ({ name: `c${i}`, outcome: i < right ? 'passed' : 'failed', detail: '' })),
  version,
  environment: { computer: 'lapto', os: 'Windows', node: '22.12.0' },
  at,
  ms: 10,
  costUsd: 0,
  ...extra,
});

describe('regression checks (CI-5)', () => {
  it('flags a test that did worse after the version changed, on the same computer', () => {
    const regs = findRegressions([result('11.2.5', 4, '2026-11-10T00:00:00Z'), result('11.2.5', 4, '2026-11-11T00:00:00Z'), result('11.3.0', 3, '2026-11-12T00:00:00Z')]);
    expect(regs).toEqual([{ capability: 'secretlint', suite: 'secretlint-planted', computer: 'lapto', from: '11.2.5', to: '11.3.0', before: 'passed (4/4)', after: 'failed (3/4)', at: '2026-11-12T00:00:00Z' }]);
    expect(regressionNote(regs)).toBe('Got worse after updating from 11.2.5 to 11.3.0 on lapto (secretlint-planted): passed (4/4) before, failed (3/4) now.');
  });

  it('doesn’t call it a regression when it’s the same version, as good, on another computer, or couldn’t run', () => {
    expect(findRegressions([result('1.0.0', 4, '2026-11-10T00:00:00Z'), result('1.0.0', 3, '2026-11-11T00:00:00Z')])).toEqual([]);
    expect(findRegressions([result('1.0.0', 3, '2026-11-10T00:00:00Z'), result('2.0.0', 3, '2026-11-11T00:00:00Z')])).toEqual([]);
    expect(findRegressions([result('1.0.0', 4, '2026-11-10T00:00:00Z'), result('2.0.0', 3, '2026-11-11T00:00:00Z', { environment: { computer: 'joshu', os: '', node: '' } })])).toEqual([]);
    expect(findRegressions([result('1.0.0', 4, '2026-11-10T00:00:00Z'), result('2.0.0', 0, '2026-11-11T00:00:00Z', { outcome: 'blocked' })])).toEqual([]);
    expect(findRegressions([result('', 4, '2026-11-10T00:00:00Z'), result('2.0.0', 3, '2026-11-11T00:00:00Z')])).toEqual([]);
    // Fixed again by the newest result: nothing to flag.
    expect(findRegressions([result('1.0.0', 4, '2026-11-10T00:00:00Z'), result('2.0.0', 3, '2026-11-11T00:00:00Z'), result('2.0.1', 4, '2026-11-12T00:00:00Z')])).toEqual([]);
  });
});

describe('experiments in the data repo (CI-5)', () => {
  let data = '';
  beforeEach(async () => {
    data = await mkdtemp(join(tmpdir(), 'aip-exp-'));
  });
  afterEach(async () => {
    await rm(data, { recursive: true, force: true });
  });

  const exp = (id: string, at: string, extra: Partial<Experiment> = {}): Experiment => ({
    id,
    question: 'Does secretlint give the same answer every time on this computer?',
    capability: 'secretlint',
    inputs: { suite: 'secretlint-planted', runs: 3 },
    measures: ['outcome each run'],
    result: { outcomes: ['passed', 'passed', 'passed'], passedRuns: 3, casesRight: ['4/4', '4/4', '4/4'], msMin: 5, msMax: 9, version: '11.2.5' },
    verdict: 'Steady.',
    status: 'proposal',
    environment: { computer: 'lapto', os: 'Windows', node: '22.12.0' },
    at,
    costUsd: 0,
    ...extra,
  });

  it('saves each experiment as its own file and lists them newest first, skipping damaged ones', async () => {
    expect(await saveExperiment(data, exp('20261112-100000-secretlint-planted-repeat', '2026-11-12T10:00:00Z'))).toBe('experiments/20261112-100000-secretlint-planted-repeat.json');
    await saveExperiment(data, exp('20261112-110000-secretlint-planted-repeat', '2026-11-12T11:00:00Z'));
    await mkdir(join(data, 'experiments'), { recursive: true });
    await writeFile(join(data, 'experiments', 'bad.json'), '{nope');
    expect((await listExperiments(data)).map((e) => e.id)).toEqual(['20261112-110000-secretlint-planted-repeat', '20261112-100000-secretlint-planted-repeat']);
  });

  it('refuses IDs that aren’t slugs and anything key-shaped', async () => {
    await expect(saveExperiment(data, exp('../x', '2026-11-12T10:00:00Z'))).rejects.toThrow(/can’t be used as an experiment ID/);
    await expect(saveExperiment(data, exp('ok-id', '2026-11-12T10:00:00Z', { verdict: `ghp_${'a1'.repeat(18)}` }))).rejects.toThrow(/held a key/);
  });
});

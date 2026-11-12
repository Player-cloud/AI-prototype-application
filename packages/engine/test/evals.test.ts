import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EvalResult, EvalSuite } from '@aip/checks';
import { emptyHealth, noteVersion, readHealth, writeHealth } from '@aip/memory';
import { runFreeTests } from '../src/evals.ts';
import { checkSettings } from '../src/settings.ts';
import { handleLine } from '../src/protocol.ts';

const NOW = new Date('2026-11-12T11:00:00Z');

const fakeRun = (outcomes: Record<string, EvalResult['outcome']>) => async (suites: readonly EvalSuite[]): Promise<EvalResult[]> =>
  suites.map((s) => ({
    suite: s.id,
    capability: s.capability,
    kind: s.kind,
    outcome: outcomes[s.capability] ?? 'passed',
    cases: [{ name: 'case', outcome: outcomes[s.capability] === 'blocked' ? 'blocked' : outcomes[s.capability] === 'failed' ? 'failed' : 'passed', detail: outcomes[s.capability] === 'failed' ? 'Missed it.' : 'Found it.' }],
    version: s.capability === 'secretlint' ? '11.3.0' : '1.0.0',
    environment: { computer: 'lapto', os: 'Windows', node: '22.12.0' },
    at: NOW.toISOString(),
    ms: 5,
    costUsd: 0,
  }));

describe('free repeatable tests (CI-3)', () => {
  let data = '';
  beforeEach(async () => {
    data = await mkdtemp(join(tmpdir(), 'aip-evalrun-'));
    await writeFile(join(data, 'ledger.md'), '- secretlint | ON | secret scan | x\n');
  });
  afterEach(async () => {
    await rm(data, { recursive: true, force: true });
  });

  it('saves results, and a pass on the new version clears the out-of-date mark', async () => {
    // secretlint was tested at 11.2.5, then updated: its evidence is stale.
    let h = noteVersion(emptyHealth('secretlint'), '11.2.5', 'lapto');
    h = noteVersion(h, '11.3.0', 'lapto');
    expect(h.stale).toBe(true);
    await writeHealth(data, h);

    const r = await runFreeTests(checkSettings({ dataFolder: data }), { now: NOW, run: fakeRun({ 'axe-core': 'blocked', playwright: 'blocked', 'checklist-rules': 'failed' }) });
    expect(r.summary).toBe('Free tests: 1 passed, 1 failed, 2 couldn’t run here (of 4). Cost: £0.00 ($0.00).');
    expect(r.synced).toMatch(/^Saved here, but not synced yet/); // not a git clone in this test
    expect(r.results.find((x) => x.capability === 'checklist-rules')).toMatchObject({ outcome: 'failed', detail: 'case: Missed it.' });

    const saved = JSON.parse(await readFile(join(data, 'evaluations', 'secretlint.json'), 'utf8'));
    expect(saved.results[0]).toMatchObject({ outcome: 'passed', version: '11.3.0' });
    const after = await readHealth(data, 'secretlint');
    expect(after).toMatchObject({ stale: false, retestDue: false, testedVersion: '11.3.0', consecutiveFailures: 0 });
    // A failed test counts as a failure; a blocked one records nothing.
    expect((await readHealth(data, 'Checklist rules', 'checklist-rules')).consecutiveFailures).toBe(1);
    expect((await readHealth(data, 'axe-core')).consecutiveFailures).toBe(0);
    expect((await readHealth(data, 'axe-core')).version).toBeNull();

    // The Tools page shows the evidence; a tool with no test stays untested ('').
    const o = JSON.parse((await handleLine(JSON.stringify({ id: 2, method: 'data_overview', params: { settings: { dataFolder: data } } })))!).result;
    expect(o.tools.find((t: { id: string }) => t.id === 'secretlint').tested).toMatch(/^Tests: passed \(1\/1\) on lapto, version 11\.3\.0, 12 Nov 2026\. 1 run so far: a first look, not proof\.$/);
  });

  it('runs one capability, and says so plainly when it has no test', async () => {
    const r = await runFreeTests(checkSettings({}), { capability: 'secretlint', run: fakeRun({}) });
    expect(r.results.map((x) => x.capability)).toEqual(['secretlint']);
    expect(r.synced).toBe('');
    await expect(runFreeTests(checkSettings({}), { capability: 'egm', run: fakeRun({}) })).rejects.toThrow('There’s no free test for egm yet, so it stays untested.');
  });

  it('is on the protocol as eval_run', async () => {
    const out = await handleLine(JSON.stringify({ id: 1, method: 'eval_run', params: { settings: {}, capability: 'nothing-here' } }));
    expect(JSON.parse(out!)).toMatchObject({ id: 1, error: expect.stringContaining('no free test for nothing-here') });
  });
});

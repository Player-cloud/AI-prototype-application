import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KEEP_EVALS, addEvals, evidenceNote, listEvals, readEvals, type StoredEval } from '../src/index.ts';

const result = (capability: string, outcome: StoredEval['outcome'], at = '2026-11-12T11:00:00Z', extra: Partial<StoredEval> = {}): StoredEval => ({
  suite: `${capability}-planted`,
  capability,
  kind: 'tool',
  outcome,
  cases: [
    { name: 'a', outcome: 'passed', detail: '' },
    { name: 'b', outcome: outcome === 'passed' ? 'passed' : 'failed', detail: '' },
  ],
  version: '1.0.0',
  environment: { computer: 'lapto', os: 'Windows', node: '22.12.0' },
  at,
  ms: 10,
  costUsd: 0,
  ...extra,
});

describe('test results in the data repo (CI-3)', () => {
  let data = '';
  beforeEach(async () => {
    data = await mkdtemp(join(tmpdir(), 'aip-evals-'));
  });
  afterEach(async () => {
    await rm(data, { recursive: true, force: true });
  });

  it('keeps one file per capability, newest last, and lists them', async () => {
    expect(await addEvals(data, [result('secretlint', 'passed'), result('axe-core', 'failed')])).toEqual(['evaluations/secretlint.json', 'evaluations/axe-core.json']);
    await addEvals(data, [result('secretlint', 'failed', '2026-11-12T12:00:00Z')]);
    const saved = JSON.parse(await readFile(join(data, 'evaluations', 'secretlint.json'), 'utf8'));
    expect(saved.capability).toBe('secretlint');
    expect(saved.results.map((r: StoredEval) => r.outcome)).toEqual(['passed', 'failed']);
    const all = await listEvals(data);
    expect([...all.keys()]).toEqual(['axe-core', 'secretlint']);
  });

  it('keeps only the last results, and skips damaged files', async () => {
    const many = Array.from({ length: KEEP_EVALS + 5 }, (_, i) => result('secretlint', 'passed', new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString()));
    await addEvals(data, many);
    const kept = await readEvals(data, 'secretlint');
    expect(kept).toHaveLength(KEEP_EVALS);
    expect(kept[0]!.at).toBe(many[5]!.at);
    await writeFile(join(data, 'evaluations', 'broken.json'), '{nope');
    await mkdir(join(data, 'evaluations'), { recursive: true });
    expect([...(await listEvals(data)).keys()]).toEqual(['secretlint']);
  });

  it('refuses anything key-shaped and IDs that aren’t slugs', async () => {
    const token = `ghp_${'a1'.repeat(18)}`;
    await expect(addEvals(data, [result('secretlint', 'failed', undefined, { cases: [{ name: 'x', outcome: 'failed', detail: token }] })])).rejects.toThrow(/looked like it held a key/);
    await expect(addEvals(data, [result('../escape', 'passed')])).rejects.toThrow(/can’t be used as a capability ID/);
  });

  it('says untested as nothing, and a few runs as a first look, not proof', () => {
    expect(evidenceNote([])).toBe('');
    expect(evidenceNote([result('secretlint', 'passed')])).toBe('Tests: passed (2/2) on lapto, version 1.0.0, 12 Nov 2026. 1 run so far: a first look, not proof.');
    const three = [result('secretlint', 'passed'), result('secretlint', 'passed'), result('secretlint', 'failed', '2026-11-13T09:00:00Z')];
    expect(evidenceNote(three)).toBe('Tests: failed (1/2) on lapto, version 1.0.0, 13 Nov 2026. 3 runs.');
  });
});

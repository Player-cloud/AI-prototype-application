import { afterEach, describe, expect, it } from 'vitest';
import { Blocked, RUBRIC, SUITES, overall, runSuites, type EvalSuite } from '../src/index.ts';

const NOW = new Date('2026-11-12T11:00:00Z');
const suite = (id: string, run: EvalSuite['run']): EvalSuite => ({ id, capability: id, label: id, kind: 'tool', covers: [], aim: '', passRule: '', free: true, run });

describe('repeatable tests per kind (CI-3)', () => {
  const saved = process.env.AIP_BROWSER;
  afterEach(() => {
    if (saved === undefined) delete process.env.AIP_BROWSER;
    else process.env.AIP_BROWSER = saved;
  });

  it('has a rubric for every kind, and each free suite says what it’s for and how it passes', () => {
    expect(Object.keys(RUBRIC)).toEqual(['model', 'tool', 'plugin', 'skill', 'mod', 'agent', 'workflow']);
    for (const s of SUITES) {
      expect(s.free).toBe(true);
      expect(s.aim).not.toBe('');
      expect(s.passRule).not.toBe('');
      for (const c of s.covers) expect(RUBRIC[s.kind]).toContain(c);
    }
    expect(SUITES.map((s) => s.capability)).toEqual(['secretlint', 'checklist-rules', 'axe-core', 'playwright']);
  });

  it('passes only when every case passes, and never turns "couldn’t run" into a pass', () => {
    expect(overall([])).toBe('not run');
    expect(overall([{ name: 'a', outcome: 'passed', detail: '' }])).toBe('passed');
    expect(overall([{ name: 'a', outcome: 'passed', detail: '' }, { name: 'b', outcome: 'failed', detail: '' }])).toBe('failed');
    expect(overall([{ name: 'a', outcome: 'passed', detail: '' }, { name: 'b', outcome: 'blocked', detail: '' }])).toBe('blocked');
  });

  it('runs the planted-problem tests for real, naming the version and the computer', async () => {
    const results = await runSuites(SUITES, { now: () => NOW });
    expect(results.map((r) => [r.suite, r.outcome])).toEqual([
      ['secretlint-planted', 'passed'],
      ['checklist-planted', 'passed'],
      ['axe-planted', 'passed'],
      ['playwright-pictures', 'passed'],
    ]);
    const s = results[0]!;
    expect(s.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(s.environment.computer).not.toBe('');
    expect(s.at).toBe(NOW.toISOString());
    expect(s.costUsd).toBe(0);
    expect(s.cases.map((c) => c.name)).toEqual(['clean file passes', 'finds a GitHub token', 'finds a private key', 'flags a .env file']);
    // Nothing key-shaped is kept in the results.
    expect(JSON.stringify(results)).not.toMatch(/ghp_|PRIVATE KEY-----/);
  }, 60_000);

  it('marks page tests blocked when the browser can’t open, and a broken tool as failed', async () => {
    process.env.AIP_BROWSER = '/nowhere/browser';
    const page = await runSuites(SUITES.filter((s) => s.id === 'axe-planted'));
    expect(page[0]).toMatchObject({ outcome: 'blocked' });
    expect(page[0]!.cases[0]!.detail).toMatch(/^Couldn’t run here: No pictures: couldn’t open/);
    const broken = await runSuites([
      suite('x', async () => {
        throw new Error('crashed\nstack');
      }),
      suite('y', async () => {
        throw new Blocked('no network');
      }),
    ]);
    expect(broken.map((r) => [r.outcome, r.cases[0]!.detail])).toEqual([
      ['failed', 'The tool broke: crashed'],
      ['blocked', 'Couldn’t run here: no network'],
    ]);
  }, 60_000);
});

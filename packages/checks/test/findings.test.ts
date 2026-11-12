import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NEEDS_OK, NEW_PACKAGE, auditCheck, canKeep, checklistCheck, secretScan, summarise, toFinding, toFindings, blockingChecks, type CheckResult, type Exec } from '../src/index.js';

const result = (name: string, over: Partial<CheckResult> = {}): CheckResult => ({ name, passed: true, free: true, ...over });

describe('every check as a finding', () => {
  it('tests: a pass, and a failure that blocks Keep', () => {
    expect(toFinding(result('tests', { detail: '3 passed' }))).toEqual({ check: 'tests', level: 'pass', title: 'Tests: passed', detail: '3 passed', source: 'tool' });
    expect(toFinding(result('tests', { passed: false, detail: 'FAIL a.test.ts' }))).toMatchObject({ level: 'block', title: 'Tests: failed', detail: 'FAIL a.test.ts' });
  });

  it('secrets: a clean scan passes, a found key blocks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aip-findings-'));
    try {
      await writeFile(join(dir, 'a.ts'), 'export const A = 1;\n');
      expect(toFinding(await secretScan(dir, ['a.ts']))).toMatchObject({ check: 'secrets', level: 'pass', title: 'Secret scan: passed', source: 'tool' });
      await writeFile(join(dir, '.env'), 'X=1\n');
      const bad = toFinding(await secretScan(dir, ['.env']));
      expect(bad).toMatchObject({ check: 'secrets', level: 'block', title: 'Secret scan: failed' });
      expect(bad.detail).toContain('key files must never be added');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('audit: pass, block on high problems, info when it could not run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aip-findings-'));
    try {
      await writeFile(join(dir, 'package.json'), '{"name":"x"}');
      await writeFile(join(dir, 'pnpm-lock.yaml'), '');
      const answer = (code: number, output: string): Exec => async () => ({ code, output });
      expect(toFinding(await auditCheck(dir, answer(0, 'No known vulnerabilities found'))).level).toBe('pass');
      expect(toFinding(await auditCheck(dir, answer(1, '1 high severity vulnerability')))).toMatchObject({ level: 'block', title: 'Package audit: failed' });
      expect(toFinding(await auditCheck(dir, answer(1, 'getaddrinfo ENOTFOUND registry.npmjs.org')))).toMatchObject({ level: 'info', title: 'Package audit: not run' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('dependencies: new packages block until approved (a rule, not a tool)', () => {
    const waiting = toFinding(result('dependencies', { passed: false, detail: `${NEW_PACKAGE}left-pad ^1.3.0 (dependencies in package.json)\n${NEEDS_OK}` }));
    expect(waiting).toMatchObject({ check: 'dependencies', level: 'block', title: 'New packages: need your OK before Keep', source: 'rule' });
    expect(waiting.detail).toContain('New: left-pad');
    expect(toFinding(result('dependencies', { detail: 'No new packages.' }))).toMatchObject({ level: 'pass', source: 'rule' });
  });

  it('checklist: advice only, so a hit is a warning and none is a pass', () => {
    const added = [{ file: 'src/a.tsx', line: 3, text: '<img src="x.png">' }];
    expect(toFinding(checklistCheck(['Accessibility'], added))).toMatchObject({ check: 'checklist', level: 'warn', source: 'rule', title: 'Checklist rules: advice (doesn’t stop Keep)' });
    expect(toFinding(checklistCheck(['Accessibility'], []))).toMatchObject({ level: 'pass' });
    expect(toFinding(checklistCheck([], added)).level).toBe('pass');
  });

  it('axe and phone width: advice when they find something, a pass otherwise', () => {
    expect(toFinding(result('axe', { passed: false, advisory: true, detail: '2 serious problems' }))).toMatchObject({ level: 'warn', title: 'Accessibility: advice (doesn’t stop Keep)' });
    expect(toFinding(result('phone-overflow', { passed: false, advisory: true }))).toMatchObject({ level: 'warn', title: 'Phone width: advice (doesn’t stop Keep)' });
    expect(toFinding(result('axe', { advisory: true }))).toMatchObject({ level: 'pass', title: 'Accessibility: passed' });
  });

  it('pictures that could not be taken are a note, never a block', () => {
    expect(toFinding(result('pictures', { passed: false, advisory: true, detail: 'No pictures: there’s no page to show.' }))).toMatchObject({ level: 'info', title: 'Pictures: not run' });
  });

  it('a check the app could not run at all blocks Keep, as before', () => {
    expect(toFinding(result('free checks', { passed: false, detail: 'Couldn’t run: boom' }))).toMatchObject({ level: 'block', title: 'Free checks: failed' });
  });

  it('keeps order and an unknown check keeps its own name', () => {
    const f = toFindings([result('secrets'), result('mystery', { passed: false })]);
    expect(f.map((x) => [x.check, x.level, x.title])).toEqual([['secrets', 'pass', 'Secret scan: passed'], ['mystery', 'block', 'mystery: failed']]);
  });
});

describe('summarise', () => {
  it('counts each level and says whether Keep is blocked', () => {
    const s = summarise([{ level: 'pass' }, { level: 'pass' }, { level: 'info' }, { level: 'warn' }, { level: 'warn' }, { level: 'warn' }]);
    expect(s).toEqual({ pass: 2, info: 1, warn: 3, block: 0, blocksKeep: false });
    expect(summarise([{ level: 'warn' }, { level: 'block' }])).toEqual({ pass: 0, info: 0, warn: 1, block: 1, blocksKeep: true });
    expect(summarise([])).toEqual({ pass: 0, info: 0, warn: 0, block: 0, blocksKeep: false });
  });

  it('lists each blocking check once', () => {
    expect(blockingChecks([{ check: 'secrets', level: 'block' }, { check: 'axe', level: 'warn' }, { check: 'secrets', level: 'block' }, { check: 'dependencies', level: 'block' }])).toEqual(['secrets', 'dependencies']);
  });
});

describe('Keep parity: the same things block Keep as with canKeep', () => {
  // Every state a check can be in today, for the checks that can block.
  const states: Record<string, Partial<CheckResult>> = {
    passed: {},
    'failed (blocks)': { passed: false },
    'failed (advice)': { passed: false, advisory: true },
    'not run (advice)': { passed: false, advisory: true, detail: 'Not run: no internet.' },
  };
  const names = ['secrets', 'audit', 'dependencies', 'checklist', 'axe'] as const;

  it('over every combination of states, for the tests passing and failing', () => {
    // Full cross product of 4 states over 5 checks = 1024 cases.
    let all: CheckResult[][] = [[]];
    for (const n of names) all = all.flatMap((prefix) => Object.values(states).map((s) => [...prefix, result(n, s)]));
    expect(all).toHaveLength(1024);
    for (const testsPassed of [true, false]) {
      for (const checks of all) {
        const results = [result('tests', { passed: testsPassed }), ...checks];
        const today = canKeep(results);
        const s = summarise(toFindings(results));
        expect(!s.blocksKeep).toBe(today.keep);
        expect(blockingChecks(toFindings(results))).toEqual(today.blocking);
      }
    }
  });

  it('a build with no tests result is still refused by canKeep (kept as is); findings never hide a block', () => {
    expect(canKeep([result('axe')])).toEqual({ keep: false, blocking: ['tests (not run)'] });
    // The run record holds the checks without tests; its tests flag is checked on its own.
    expect(summarise(toFindings([result('axe')])).blocksKeep).toBe(false);
  });
});

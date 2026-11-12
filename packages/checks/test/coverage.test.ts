import { describe, expect, it } from 'vitest';
import { canKeep } from '../src/index.js';
import { coverageFinding, coverageFromFindings, idsInName, linkCriteria, neverCheckedLine, parseDoneList, parseTestCases } from '../src/coverage.js';
import { nameFlags, runTests } from '../src/tests.js';
import { summarise, toFindings } from '../src/findings.js';

const DONE = `# F-01 Login: done when

Each line passes or fails.

- [ ] A member can sign in
* [x] A wrong password shows an error

## Later
1. Sessions end after a day
2) The page works on a phone

   
plain prose is not a line
`;

describe('parseDoneList', () => {
  it('numbers bullets, numbers and checkboxes in order; ignores headings, blanks and prose', () => {
    expect(parseDoneList(DONE)).toEqual([
      { id: 'D1', text: 'A member can sign in' },
      { id: 'D2', text: 'A wrong password shows an error' },
      { id: 'D3', text: 'Sessions end after a day' },
      { id: 'D4', text: 'The page works on a phone' },
    ]);
  });
  it('gives the same ids every time, and none for an empty file', () => {
    expect(parseDoneList(DONE)).toEqual(parseDoneList(DONE));
    expect(parseDoneList('# Only a heading\n\n')).toEqual([]);
  });
});

describe('test names from a run', () => {
  const OUT = [
    ' ✓ src/login.test.ts > login > D1: a member can sign in 4ms',
    ' × src/login.test.ts > login > D2: a wrong password shows an error 3ms',
    '   ✓ D3: sessions end (12 ms)',
    ' ↓ src/login.test.ts > D4: skipped',
    ' FAIL  src/login.test.ts > login > D2: a wrong password shows an error',
    '\u001b[32m ✓\u001b[39m nothing special',
  ].join('\n');
  it('reads passing and failing names, skipped ones are ignored', () => {
    const c = parseTestCases(OUT);
    expect(c).toContainEqual({ name: 'D1: a member can sign in', passed: true });
    expect(c).toContainEqual({ name: 'D2: a wrong password shows an error', passed: false });
    expect(c).toContainEqual({ name: 'D3: sessions end', passed: true });
    expect(c.some((x) => x.name.includes('skipped'))).toBe(false);
  });
  it('finds ids only as whole tokens in the test’s own name', () => {
    expect(idsInName('D2: shows an error')).toEqual(['D2']);
    expect(idsInName('D2 and D10 work')).toEqual(['D2', 'D10']);
    expect(idsInName('ID2 and D2x and F-D2 and D-2')).toEqual([]);
    expect(idsInName('it shows the error')).toEqual([]);
  });
});

describe('linking tests to lines', () => {
  const lines = parseDoneList(DONE);
  it('tested, failed and not-checked', () => {
    const covered = linkCriteria(lines, [
      { name: 'D1: a member can sign in', passed: true },
      { name: 'D2: a wrong password shows an error', passed: true },
      { name: 'D2: and the error clears', passed: false },
    ]);
    expect(covered.map((c) => [c.id, c.status])).toEqual([['D1', 'tested'], ['D2', 'failed'], ['D3', 'not-checked'], ['D4', 'not-checked']]);
  });
  it('never guesses from the words: the same text without an id is not checked', () => {
    const covered = linkCriteria(lines, [{ name: 'a member can sign in', passed: true }, { name: 'A wrong password shows an error', passed: true }]);
    expect(covered.every((c) => c.status === 'not-checked')).toBe(true);
  });
  it('an id with no such line links to nothing', () => {
    expect(linkCriteria(lines, [{ name: 'D9: x', passed: true }]).every((c) => c.status === 'not-checked')).toBe(true);
  });
});

describe('the coverage finding', () => {
  const lines = parseDoneList(DONE);
  it('pass when all tested, warn when some never checked, block only when one failed', () => {
    const all = lines.map((l) => ({ name: `${l.id}: x`, passed: true }));
    expect(coverageFinding(linkCriteria(lines, all))).toMatchObject({ check: 'done-list', level: 'pass', source: 'rule' });
    const some = coverageFinding(linkCriteria(lines, all.slice(0, 1)))!;
    expect(some.level).toBe('warn');
    expect(some.title).toContain('3 of 4 lines were never checked');
    expect(some.detail).toContain('D1 ✓ tested: A member can sign in');
    expect(some.detail).toContain('D2 – not checked: A wrong password shows an error');
    const bad = coverageFinding(linkCriteria(lines, [{ name: 'D1: x', passed: false }]))!;
    expect(bad.level).toBe('block');
    expect(bad.detail).toContain('D1 ✗ failed');
    expect(coverageFinding([])).toBeNull();
  });
  it('reads back from the detail, and an old row without it reads as nothing', () => {
    const f = coverageFinding(linkCriteria(lines, [{ name: 'D1: x', passed: true }]))!;
    const back = coverageFromFindings([{ check: 'secrets' }, f])!;
    expect(back.map((c) => c.status)).toEqual(['tested', 'not-checked', 'not-checked', 'not-checked']);
    expect(neverCheckedLine(back)).toBe('3 of 4 done-list lines were never checked');
    expect(coverageFromFindings([{ check: 'secrets', detail: 'x' }])).toBeNull();
    expect(coverageFromFindings([])).toBeNull();
  });
  it('does not change what blocks Keep: a coverage block only comes with a failing test, which already blocks', () => {
    const failingTests = { name: 'tests', passed: false, free: true };
    const passingTests = { name: 'tests', passed: true, free: true };
    // Keep is decided from the checks alone: adding or removing coverage changes nothing.
    expect(canKeep([failingTests]).keep).toBe(false);
    expect(canKeep([passingTests, { name: 'checklist', passed: false, free: true, advisory: true }]).keep).toBe(true);
    // A warn (never checked) is advice: it does not count as a block.
    const warn = coverageFinding(linkCriteria(parseDoneList(DONE), []))!;
    expect(summarise([...toFindings([passingTests]), warn]).blocksKeep).toBe(false);
    // A linked failure is a block, and only exists when a test failed.
    const bad = coverageFinding(linkCriteria(parseDoneList(DONE), [{ name: 'D1: x', passed: false }]))!;
    expect(summarise([...toFindings([failingTests]), bad]).blocksKeep).toBe(true);
  });
});

describe('running tests with names', () => {
  it('asks vitest and jest for test names, and nothing else', () => {
    expect(nameFlags('pnpm', 'vitest run')).toEqual(['--reporter=verbose']);
    expect(nameFlags('npm', 'vitest run')).toEqual(['--', '--reporter=verbose']);
    expect(nameFlags('yarn', 'jest')).toEqual(['--verbose']);
    expect(nameFlags('pnpm', 'vitest run --reporter=dot')).toEqual([]);
    expect(nameFlags('pnpm', 'vitest run && tsc')).toEqual([]);
    expect(nameFlags('pnpm', 'mocha')).toEqual([]);
  });
  it('returns the test cases it read, and none when the output has no names', async () => {
    const { mkdtemp, writeFile, mkdir, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'aip-cov-'));
    try {
      await writeFile(join(dir, 'package.json'), '{"scripts": {"test": "vitest run"}}');
      await mkdir(join(dir, 'node_modules'));
      const r = await runTests(dir, async () => ({ code: 0, output: ' ✓ a.test.ts > D1: works 2ms' }));
      expect(r.cases).toEqual([{ name: 'D1: works', passed: true }]);
      expect((await runTests(dir, async () => ({ code: 0, output: '3 passed' }))).cases).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

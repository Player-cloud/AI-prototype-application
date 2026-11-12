/**
 * Done-check coverage: each line of a feature's done file is marked tested, failed or not checked.
 *
 * The link is simple on purpose. The build is asked to put a line's id in the test's name
 * (`it('D2: shows an error')`). After the tests run, a test whose own name has the id counts for that
 * line: passing means tested, failing means failed. No id in any test name means not checked.
 * Nothing is matched by guessing at the words. Only 'failed' blocks Keep, and a failing test
 * already blocks Keep, so this never changes what Keep allows.
 */
import type { Finding } from './findings.js';

export type CoverageStatus = 'tested' | 'failed' | 'not-checked';
export interface Criterion { id: string; text: string }
export interface Covered extends Criterion { status: CoverageStatus }
/** One test the run reported: its name and whether it passed. */
export interface TestCase { name: string; passed: boolean }

export const COVERAGE_CHECK = 'done-list';

/** A bullet, a number or a checkbox at the start of a line. Headings, blanks and plain prose are not lines. */
const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/;

/** The lines of a done file, with ids D1, D2... by order. */
export function parseDoneList(text: string): Criterion[] {
  const out: Criterion[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s{0,3}#/.test(raw)) continue;
    const m = LIST_LINE.exec(raw);
    if (!m || !m[1]) continue;
    out.push({ id: `D${out.length + 1}`, text: m[1] });
  }
  return out;
}

const ANSI = /\u001b\[[0-9;]*m/g;
const PASS_MARK = /^\s*(?:✓|✔|√)\s+(.+)$/;
const FAIL_MARK = /^\s*(?:×|✗|✕|✘)\s+(.+)$/;
const FAIL_WORD = /^\s*FAIL\s+(.+)$/;

/** The test name on a result line: after the last " > " (vitest's file > suite > test), without its timing. */
function titleOf(rest: string): string {
  const last = rest.split(' > ').pop() ?? rest;
  return last.replace(/\s+\(?\d+(\.\d+)?\s*m?s\)?\s*$/, '').trim();
}

/**
 * Test names from a test run's output, for runners that print one line per test with a tick or cross
 * (vitest's verbose reporter, jest --verbose). Anything else in the output is ignored.
 */
export function parseTestCases(output: string): TestCase[] {
  const out: TestCase[] = [];
  for (const line of output.replace(ANSI, '').split(/\r?\n/)) {
    const pass = PASS_MARK.exec(line);
    if (pass?.[1]) { out.push({ name: titleOf(pass[1]), passed: true }); continue; }
    const fail = FAIL_MARK.exec(line) ?? FAIL_WORD.exec(line);
    if (fail?.[1]) out.push({ name: titleOf(fail[1]), passed: false });
  }
  return out;
}

/** The done-list ids a test name carries ("D2: ...", "D2 and D3: ..."), nothing else. */
export function idsInName(name: string): string[] {
  return [...new Set([...name.matchAll(/(?<![\w-])D(\d+)(?![\w-])/g)].map((m) => `D${Number(m[1])}`))];
}

/** Each line's status from the tests that name it. */
export function linkCriteria(criteria: Criterion[], cases: TestCase[]): Covered[] {
  const seen = new Map<string, { pass: number; fail: number }>();
  for (const c of cases) {
    for (const id of idsInName(c.name)) {
      const s = seen.get(id) ?? { pass: 0, fail: 0 };
      if (c.passed) s.pass += 1; else s.fail += 1;
      seen.set(id, s);
    }
  }
  return criteria.map((c) => {
    const s = seen.get(c.id);
    const status: CoverageStatus = !s ? 'not-checked' : s.fail > 0 ? 'failed' : 'tested';
    return { ...c, status };
  });
}

export const STATUS_MARK: Record<CoverageStatus, string> = { tested: '✓ tested', failed: '✗ failed', 'not-checked': '– not checked' };

/** The coverage as one finding. null when the feature has no done-list lines. */
export function coverageFinding(covered: Covered[]): Finding | null {
  if (covered.length === 0) return null;
  const never = covered.filter((c) => c.status === 'not-checked').length;
  const failed = covered.filter((c) => c.status === 'failed').length;
  const total = covered.length;
  const detail = covered.map((c) => `${c.id} ${STATUS_MARK[c.status]}: ${c.text}`).join('\n');
  if (failed > 0) return { check: COVERAGE_CHECK, level: 'block', title: `Done list: ${failed} of ${total} lines have a failing test`, detail, source: 'rule' };
  if (never > 0) return { check: COVERAGE_CHECK, level: 'warn', title: `Done list: ${never} of ${total} lines were never checked (advice, doesn’t stop Keep)`, detail, source: 'rule' };
  return { check: COVERAGE_CHECK, level: 'pass', title: `Done list: all ${total} lines tested`, detail, source: 'rule' };
}

/** Read the lines back out of a coverage finding's detail. Old rows (no such finding) give null. */
export function coverageFromFindings(findings: Pick<Finding, 'check' | 'detail'>[]): Covered[] | null {
  const f = findings.find((x) => x.check === COVERAGE_CHECK);
  if (!f?.detail) return null;
  const out: Covered[] = [];
  for (const line of f.detail.split('\n')) {
    const m = /^(D\d+) (✓ tested|✗ failed|– not checked): (.*)$/.exec(line);
    if (!m) continue;
    const status: CoverageStatus = m[2] === '✓ tested' ? 'tested' : m[2] === '✗ failed' ? 'failed' : 'not-checked';
    out.push({ id: m[1]!, text: m[3]!, status });
  }
  return out.length ? out : null;
}

/** The plain line for the report. */
export function neverCheckedLine(covered: Covered[]): string {
  const never = covered.filter((c) => c.status === 'not-checked').length;
  return `${never} of ${covered.length} done-list lines were never checked`;
}

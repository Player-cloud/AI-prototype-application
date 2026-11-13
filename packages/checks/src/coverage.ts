/**
 * Done-check coverage: each line of a feature's done file is marked tested, failed or not checked.
 *
 * The link is simple on purpose. The build is asked to put a line's id in the test's name
 * (`it('D2: shows an error')`). After the tests run, a test whose own name has the id counts for that
 * line: passing means tested, failing means failed. No id in any test name means not checked.
 * Nothing is matched by guessing at the words. Only 'failed' blocks Keep, and a failing test
 * already blocks Keep, so this never changes what Keep allows.
 * A linked test whose body has no assertion at all proves nothing: that line is 'not-checked',
 * with the reason (see `flagNoAssertions`). It only looks when it can find the test's body.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Finding } from './findings.js';

export type CoverageStatus = 'tested' | 'failed' | 'not-checked';
export interface Criterion { id: string; text: string }
export interface Covered extends Criterion { status: CoverageStatus; /** Why a line that has a linked test is still not checked. */ reason?: string }
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

/** Starts the line under a done-list line that says why it is still not checked. */
export const REASON_MARK = '  ↳ ';
export const NO_ASSERTIONS = 'test has no assertions';

export const STATUS_MARK: Record<CoverageStatus, string> = { tested: '✓ tested', failed: '✗ failed', 'not-checked': '– not checked' };

/** The coverage as one finding. null when the feature has no done-list lines. */
export function coverageFinding(covered: Covered[]): Finding | null {
  if (covered.length === 0) return null;
  const never = covered.filter((c) => c.status === 'not-checked').length;
  const failed = covered.filter((c) => c.status === 'failed').length;
  const total = covered.length;
  const detail = covered.map((c) => `${c.id} ${STATUS_MARK[c.status]}: ${c.text}${c.reason ? `\n${REASON_MARK}${c.reason}` : ''}`).join('\n');
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
    if (line.startsWith(REASON_MARK) && out.length) {
      out[out.length - 1]!.reason = line.slice(REASON_MARK.length);
      continue;
    }
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

// ---- Tests with no assertions -------------------------------------------------------------

/** What counts as an assertion: expect(, assert, should., toBe..., and node:test's t.is / t.true... */
const ASSERTION = /\bexpect\s*\(|\bassert\b|\bshould\b\.|\.should\b|\.to[A-Z]\w*\s*\(|\bt\.(?:is|not|true|false|truthy|falsy|deepEqual|notDeepEqual|throws|notThrows|assert|snapshot|regex|pass|fail)\b/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const TEST_FOLDER = /(?:^|\/)(?:tests?|__tests__)\//i;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/i;
const SKIP_FOLDERS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out']);
const MAX_FILES = 3000;
const MAX_BYTES = 1_000_000;

/** The index of the bracket that closes the one at `open`, skipping strings, templates and comments. -1 when there isn't one. */
function closing(src: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl < 0) return -1;
      i = nl;
    } else if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 1;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      i = endOfString(src, i);
      if (i < 0) return -1;
    } else if (pairs[ch]) {
      stack.push(pairs[ch]!);
    } else if (ch === ')' || ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** The index of the quote that ends the string starting at `start`. Template `${}` parts are walked too. -1 when unterminated. */
function endOfString(src: string, start: number): number {
  const q = src[start]!;
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '\\') i++;
    else if (ch === q) return i;
    else if (q === '`' && ch === '$' && src[i + 1] === '{') {
      const end = closing(src, i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (q !== '`' && ch === '\n') return -1;
  }
  return -1;
}

const TEST_CALL = /(?<![\w.$])(?:it|test)(?:\.(?:only|concurrent|serial|skip))?\s*\(\s*(['"`])/g;

/** Every `it(` / `test(` block in one file whose name has a done-list id: the id(s) and whether the body has an assertion. */
export function testBlocks(src: string): { name: string; ids: string[]; asserts: boolean }[] {
  const out: { name: string; ids: string[]; asserts: boolean }[] = [];
  for (const m of src.matchAll(TEST_CALL)) {
    const call = m.index! + m[0].lastIndexOf('(');
    const quote = m.index! + m[0].length - 1;
    const nameEnd = endOfString(src, quote);
    const end = closing(src, call);
    if (nameEnd < 0 || end < 0 || nameEnd > end) continue; // body can't be found: leave it alone
    const name = src.slice(quote + 1, nameEnd);
    if (src[quote] === '`' && name.includes('${')) continue; // a name built at run time can't be matched
    const ids = idsInName(name);
    if (ids.length === 0) continue;
    const body = src.slice(nameEnd + 1, end);
    if (!/=>|\bfunction\b/.test(body)) continue; // no callback (todo, or a helper passed by name): can't tell
    out.push({ name, ids, asserts: ASSERTION.test(body) });
  }
  return out;
}

async function testFiles(dir: string, rel = '', found: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(dir, rel), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    if (found.length >= MAX_FILES) break;
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_FOLDERS.has(e.name)) await testFiles(dir, path, found);
    } else if (e.isFile() && SOURCE_FILE.test(e.name) && (TEST_FILE.test(e.name) || TEST_FOLDER.test(path))) found.push(path);
  }
  return found;
}

/**
 * A line whose only linked tests have no assertion is not 'tested': it becomes 'not-checked', with the
 * reason "test has no assertions". Conservative: it scans the build copy's test files for it()/test()
 * blocks named with the id, and changes a line only when it found a body for every passing test that
 * names it and none of them asserts anything. A body it can't find leaves the status as it is.
 */
export async function flagNoAssertions(covered: Covered[], cases: TestCase[], dir: string, files?: () => Promise<{ path: string; text: string }[]>): Promise<Covered[]> {
  if (!covered.some((c) => c.status === 'tested')) return covered;
  let blocks: ReturnType<typeof testBlocks> = [];
  try {
    const read =
      files ??
      (async () => {
        const out: { path: string; text: string }[] = [];
        for (const path of await testFiles(dir)) {
          try {
            const text = await readFile(join(dir, path), 'utf8');
            if (text.length <= MAX_BYTES) out.push({ path, text });
          } catch {
            // unreadable: skip it
          }
        }
        return out;
      });
    for (const f of await read()) blocks = blocks.concat(testBlocks(f.text));
  } catch {
    return covered;
  }
  return covered.map((c) => {
    if (c.status !== 'tested') return c;
    const mine = blocks.filter((b) => b.ids.includes(c.id));
    const passing = cases.filter((t) => t.passed && idsInName(t.name).includes(c.id)).length;
    if (mine.length === 0 || mine.length < passing || mine.some((b) => b.asserts)) return c;
    return { ...c, status: 'not-checked' as const, reason: NO_ASSERTIONS };
  });
}

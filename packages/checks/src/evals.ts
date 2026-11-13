/**
 * CI-3: repeatable tests per kind of capability. Each suite says what it's for, what it feeds in,
 * what it expects, and how it passes, and runs through this package's own runners on test data
 * (no second test runner, nothing private sent anywhere). Results are passed, failed, skipped,
 * blocked or not run, never a made-up number, and always name the version and the computer.
 *
 * The suites here are the free ones: planted problems the tool must find, and a clean case it
 * must not complain about. Model suites cost money, so they come later and only with joshua's OK.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { computerId } from './environment.js';
import { checklistCheck, secretScan, type AddedLine } from './free.js';
import { takePictures } from './pictures.js';
import { checkToolVersions } from './versions.js';

export type Outcome = 'passed' | 'failed' | 'skipped' | 'blocked' | 'not run';
export type EvalKind = 'model' | 'tool' | 'plugin' | 'skill' | 'mod' | 'agent' | 'workflow';

/** What each kind is judged on (product requirements §6). Kinds are never scored against each other. */
export const RUBRIC: Record<EvalKind, string[]> = {
  model: ['task success', 'coding quality', 'following instructions', 'tool use', 'context handling', 'cost', 'speed'],
  tool: ['does its job', 'reliability', 'error handling', 'speed', 'correct output'],
  plugin: ['permissions', 'data handling', 'reliability', 'dependencies', 'clean removal'],
  skill: ['triggers at the right time', 'clarity', 'consistency', 'token overhead', 'conflicts'],
  mod: ['source integrity', 'compatibility', 'stability', 'permissions', 'can be undone'],
  agent: ['stays in scope', 'tool-use accuracy', 'cost per task', 'hand-off quality'],
  workflow: ['end-to-end success', 'defects', 'total cost', 'time', 'how often the user stepped in'],
};

export interface CaseResult { name: string; outcome: Outcome; detail: string }

/** A test could not run here (no browser, say): the result is "blocked", never "passed". */
export class Blocked extends Error {}

export interface EvalSuite {
  id: string;
  /** The capability's stable ID (its card file name). */
  capability: string;
  /** Its name in plain words. */
  label: string;
  kind: EvalKind;
  /** Which rubric points it covers. */
  covers: string[];
  aim: string;
  passRule: string;
  /** Free suites run without asking; paid ones need joshua's OK first. */
  free: boolean;
  run(dir: string): Promise<CaseResult[]>;
}

export interface EvalResult {
  suite: string;
  capability: string;
  kind: EvalKind;
  outcome: Outcome;
  cases: CaseResult[];
  /** The capability's version and where it ran. */
  version: string;
  environment: { computer: string; os: string; node: string };
  at: string;
  ms: number;
  costUsd: number;
}

const ok = (name: string, good: boolean, detail: string): CaseResult => ({ name, outcome: good ? 'passed' : 'failed', detail });

// Test-only key shapes, made at run time so no key-shaped text sits in this repo. The private key
// starts like a real one (an ASN.1 sequence) because secretlint rightly ignores placeholders.
const fakeGithubToken = () => `ghp_${randomBytes(18).toString('hex')}`;
const KIND_OF_KEY = 'RSA PRIVATE';
const fakePrivateKey = () => `-----BEGIN ${KIND_OF_KEY} KEY-----\n${Buffer.concat([Buffer.from([0x30, 0x82, 0x02, 0x5c]), randomBytes(600)]).toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END ${KIND_OF_KEY} KEY-----`;

const secretlintSuite: EvalSuite = {
  id: 'secretlint-planted',
  capability: 'secretlint',
  label: 'secretlint',
  kind: 'tool',
  covers: ['does its job', 'correct output'],
  aim: 'Finds planted keys, flags key files, and stays quiet on a clean file.',
  passRule: 'All 4 cases right.',
  free: true,
  async run(dir) {
    await writeFile(join(dir, 'clean.ts'), 'export const greeting = "hello";\n');
    await writeFile(join(dir, 'token.ts'), `export const t = "${fakeGithubToken()}";\n`);
    await writeFile(join(dir, 'key.pem.txt'), `${fakePrivateKey()}\n`);
    await writeFile(join(dir, '.env'), 'NOTHING=here\n');
    const clean = await secretScan(dir, ['clean.ts']);
    const token = await secretScan(dir, ['token.ts']);
    const key = await secretScan(dir, ['key.pem.txt']);
    const envFile = await secretScan(dir, ['.env']);
    return [
      ok('clean file passes', clean.passed, clean.passed ? 'No false alarm.' : 'Flagged a clean file.'),
      ok('finds a GitHub token', !token.passed, token.passed ? 'Missed it.' : 'Found it.'),
      ok('finds a private key', !key.passed, key.passed ? 'Missed it.' : 'Found it.'),
      ok('flags a .env file', !envFile.passed, envFile.passed ? 'Missed it.' : 'Flagged it.'),
    ];
  },
};

const PLANTED: { area: string; line: AddedLine; rule: string }[] = [
  { area: 'Security', line: { file: 'a.ts', line: 1, text: 'eval(userInput)' }, rule: 'eval' },
  { area: 'Security', line: { file: 'b.tsx', line: 1, text: 'el.innerHTML = html' }, rule: 'raw HTML' },
  { area: 'Logins and accounts', line: { file: 'c.ts', line: 1, text: 'console.log("password", password)' }, rule: 'logging a password' },
  { area: 'Accessibility', line: { file: 'd.tsx', line: 1, text: '<img src="logo.png">' }, rule: 'image without alt text' },
  { area: 'Errors and empty states', line: { file: 'e.ts', line: 1, text: 'try { go() } catch (e) {}' }, rule: 'empty catch' },
  { area: 'Phone and desktop layout', line: { file: 'f.css', line: 1, text: '.box { width: 900px; }' }, rule: 'fixed width too wide for a phone' },
];

const checklistSuite: EvalSuite = {
  id: 'checklist-planted',
  capability: 'checklist-rules',
  label: 'Checklist rules',
  kind: 'tool',
  covers: ['does its job', 'correct output'],
  aim: 'Each checklist rule finds its planted problem, and clean lines raise nothing.',
  passRule: `All ${PLANTED.length + 1} cases right.`,
  free: true,
  async run() {
    const areas = [...new Set(PLANTED.map((p) => p.area))];
    const cases = PLANTED.map((p) => {
      const r = checklistCheck([p.area], [p.line]);
      return ok(`finds ${p.rule}`, !r.passed, r.passed ? 'Missed it.' : 'Found it.');
    });
    const clean = checklistCheck(areas, [
      { file: 'g.tsx', line: 1, text: '<img src="logo.png" alt="Club HR logo">' },
      { file: 'h.css', line: 1, text: '.box { max-width: 900px; }' },
      { file: 'i.ts', line: 1, text: 'console.log("saved")' },
    ]);
    cases.push(ok('clean lines raise nothing', clean.passed, clean.passed ? 'No false alarm.' : clean.detail ?? 'Flagged clean lines.'));
    return cases;
  },
};

/** A page with 3 planted accessibility problems and a table too wide for a phone. */
const BAD_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Leave</title></head>
<body><main><h1>Leave requests</h1><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
<input type="text"><table style="width:1200px"><tr><td>Wide</td></tr></table></main></body></html>`;

/** The pictures run once and serve both page suites. */
let pageRun: Promise<Awaited<ReturnType<typeof takePictures>>> | null = null;
async function pictures(dir: string) {
  await writeFile(join(dir, 'index.html'), BAD_PAGE);
  const r = await takePictures(dir, join(dir, '..', `${Date.now()}-pictures`));
  if (r.pictures.length === 0) throw new Blocked(r.note.split('\n')[0]);
  return r;
}

const axeSuite: EvalSuite = {
  id: 'axe-planted',
  capability: 'axe-core',
  label: 'axe-core',
  kind: 'tool',
  covers: ['does its job', 'correct output'],
  aim: 'Finds planted accessibility problems (image without alt, unlabelled box, no page language) and a page too wide for a phone.',
  passRule: 'All 4 problems found.',
  free: true,
  async run(dir) {
    const r = await (pageRun ??= pictures(dir));
    const axe = r.checks.find((c) => c.name === 'axe');
    const phone = r.checks.find((c) => c.name === 'phone-overflow');
    const found = (id: string) => ok(`finds ${id}`, !!axe?.detail?.includes(id), axe?.detail?.includes(id) ? 'Found it.' : 'Missed it.');
    return [found('image-alt'), found('label'), found('html-has-lang'), ok('finds the page too wide for a phone', phone?.passed === false, phone?.detail ?? 'No result.')];
  },
};

const playwrightSuite: EvalSuite = {
  id: 'playwright-pictures',
  capability: 'playwright',
  label: 'Playwright',
  kind: 'tool',
  covers: ['does its job', 'reliability', 'speed'],
  aim: 'Takes a desktop and a phone picture of a plain page with the browser already on the computer.',
  passRule: 'Both pictures taken.',
  free: true,
  async run(dir) {
    const r = await (pageRun ??= pictures(dir));
    return (['desktop', 'phone'] as const).map((n) => {
      const p = r.pictures.find((x) => x.name === n);
      return ok(`takes the ${n} picture`, !!p, p ? 'Taken.' : 'Not taken.');
    });
  },
};

export const SUITES: readonly EvalSuite[] = [secretlintSuite, checklistSuite, axeSuite, playwrightSuite];

/** Passed only when every case passed; any failed case fails it. */
export function overall(cases: CaseResult[]): Outcome {
  if (cases.length === 0) return 'not run';
  if (cases.some((c) => c.outcome === 'failed')) return 'failed';
  if (cases.some((c) => c.outcome === 'blocked')) return 'blocked';
  return cases.every((c) => c.outcome === 'skipped') ? 'skipped' : 'passed';
}

/** Runs suites on test data in a throwaway folder. Free suites only, unless told otherwise. */
export async function runSuites(suites: readonly EvalSuite[] = SUITES, opts: { now?: () => Date; versions?: Record<string, string> } = {}): Promise<EvalResult[]> {
  const now = opts.now ?? (() => new Date());
  const versions = opts.versions ?? checkToolVersions();
  const environment = { computer: computerId(), os: `${platform()} ${release()}`, node: process.version.replace(/^v/, '') };
  const root = await mkdtemp(join(tmpdir(), 'aip-eval-'));
  pageRun = null;
  const out: EvalResult[] = [];
  try {
    for (const s of suites) {
      const dir = join(root, s.id);
      await mkdir(dir, { recursive: true });
      const start = Date.now();
      let cases: CaseResult[];
      try {
        cases = await s.run(dir);
      } catch (err) {
        const why = (err as Error).message.split('\n')[0] ?? '';
        cases = [{ name: 'run', outcome: err instanceof Blocked ? 'blocked' : 'failed', detail: err instanceof Blocked ? `Couldn’t run here: ${why}` : `The tool broke: ${why}` }];
      }
      out.push({
        suite: s.id,
        capability: s.capability,
        kind: s.kind,
        outcome: overall(cases),
        cases,
        version: versions[s.capability] ?? '',
        environment,
        at: now().toISOString(),
        ms: Date.now() - start,
        costUsd: 0,
      });
    }
  } finally {
    pageRun = null;
    await rm(root, { recursive: true, force: true });
  }
  return out;
}

/**
 * V2 item B: an honest build report. The model's summary is what it says it did; the app's own
 * tests and checks are what was really checked. On joshua's first real run the summary said an
 * audit had run when the app's own audit hadn't. So each thing the summary claims is set beside
 * what the app found: agreed, contradicted, or not checked by the app at all.
 */
import type { CheckResult } from '@aip/checks';

export interface Claim {
  /** What the summary talks about, in plain words. */
  topic: string;
  /** true: the app's own check agrees. false: it disagrees. null: the app didn't check this. */
  agrees: boolean | null;
  /** Plain words: what the app found. */
  note: string;
}

interface Topic {
  topic: string;
  /** Words in the summary that make it a claim about this topic. */
  words: RegExp;
  /** The app's own check for it, or none when the app doesn't check it. */
  check?: string;
}

const TOPICS: Topic[] = [
  { topic: 'Tests', words: /\b(tests?|specs?)\b/i, check: 'tests' },
  { topic: 'Done list', words: /\b(done[- ](list|file|checks?)|every (done )?(check|line|criteri\w+)|all (the )?(checks|criteria|requirements))\b/i, check: 'done-list' },
  { topic: 'Package audit', words: /\b(audit(ed|s)?|vulnerabilit(y|ies))\b/i, check: 'audit' },
  { topic: 'Secret scan', words: /\b(secrets?|api keys?|credentials?|\.env)\b/i, check: 'secrets' },
  { topic: 'Accessibility', words: /\b(accessib\w*|a11y|alt text|aria|screen readers?)\b/i, check: 'axe' },
  { topic: 'Phone width', words: /\b(mobile|responsive|phones?)\b/i, check: 'phone-overflow' },
  { topic: 'Type check', words: /\b(type-?check(s|ed|ing)?|tsc|types? (are|is) (ok|fine|clean))\b/i },
  { topic: 'Lint', words: /\b(lint(s|ed|ing|er)?|eslint|biome)\b/i },
  { topic: 'Production build', words: /\b(next build|vite build|(the )?build (succeeds|succeeded|passes|passed|works|is green)|builds (cleanly|successfully))\b/i },
];

const notRun = (c: CheckResult) => !c.passed && (c.detail ?? '').startsWith('Not run');

function verdict(c: CheckResult): { agrees: boolean | null; note: string } {
  if (notRun(c)) return { agrees: null, note: `The app’s own check didn’t run (${(c.detail ?? '').replace(/^Not run:\s*/, '').split('\n')[0]}).` };
  if (c.passed) return { agrees: true, note: 'The app checked this itself: passed.' };
  if (c.advisory) return { agrees: false, note: 'The app checked this itself: see the notes below (advice, doesn’t stop Keep).' };
  return { agrees: false, note: 'The app checked this itself: it failed.' };
}

/**
 * What the summary claims, beside what the app found. `results` are the app's own: the tests
 * (named "tests") and every free check. Only topics the summary mentions are listed.
 */
export function compareClaims(summary: string, results: CheckResult[]): Claim[] {
  const out: Claim[] = [];
  for (const t of TOPICS) {
    if (!t.words.test(summary)) continue;
    const c = t.check ? results.find((r) => r.name === t.check) : undefined;
    if (!c) {
      const note = t.check ? 'The app has no result for this in this build, so only the model says so.' : 'The app doesn’t check this itself, so only the model says so.';
      out.push({ topic: t.topic, agrees: null, note });
      continue;
    }
    out.push({ topic: t.topic, ...verdict(c) });
  }
  return out;
}

/** One line per claim for the phone message: "✓ Tests: …". */
export function claimLines(claims: Claim[]): string[] {
  return claims.map((c) => `${c.agrees === true ? '✓' : c.agrees === false ? '✗' : '?'} ${c.topic}: ${c.note}`);
}

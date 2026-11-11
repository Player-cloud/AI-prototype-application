/**
 * Step 7c: the plan review. Every finished plan gets one review by the plan-review model (Sonnet
 * for Claude), as the ledger says. Big plans (5+ features, or logins, payments or personal data)
 * get fresh-eyes reviews instead: separate reviewers, each seeing only the spec and done files,
 * each with its own focus. Findings are saved as review.md next to the spec; nothing in the plan
 * changes until joshua edits it.
 */
import { renderSpec, type Interview } from './interview.ts';

export interface Reviewer { id: string; focus: string }

/** One pass for every plan. */
export const ONE_PASS: Reviewer = { id: 'plan', focus: 'the whole plan: gaps, unclear features, done checks that can’t clearly pass or fail' };

/** Fresh eyes for big plans: three separate reviewers, each with a different focus. */
export const FRESH_EYES: readonly Reviewer[] = [
  { id: 'users', focus: 'who it is for and their goals: is anything they need missing from the features?' },
  { id: 'features', focus: 'features and done checks: is each feature small enough for one build, and can every check clearly pass or fail?' },
  { id: 'risk', focus: 'logins, payments, personal data and security: what could go wrong, and which done checks are missing?' },
];

export const reviewersFor = (big: boolean): readonly Reviewer[] => (big ? FRESH_EYES : [ONE_PASS]);

export type Severity = 'must' | 'should' | 'could';
export interface Finding { reviewer: string; severity: Severity; text: string; feature?: string }

/** The spec and done files as one text: all a fresh-eyes reviewer gets to see. */
export function specText(iv: Interview, now: Date): string {
  const files = renderSpec(iv, now);
  return Object.entries(files)
    .map(([path, text]) => `=== ${path} ===\n${text}`)
    .join('\n');
}

export function reviewPrompt(spec: string, r: Reviewer): string {
  return [
    'You are reviewing a web app plan with fresh eyes. You have not seen how it was made.',
    `Look only at ${r.focus}`,
    'Give up to 6 findings. Severity: "must" (would cause a wrong or unsafe build), "should" (likely trouble), "could" (nice to have).',
    'Use plain, short words. Name the feature ID when a finding is about one feature.',
    'Reply with JSON only: {"findings": [{"severity": "must", "text": "...", "feature": "F-01"}]}',
    '',
    spec,
  ].join('\n');
}

const SEVERITIES: Severity[] = ['must', 'should', 'could'];

/** Reads one reviewer's reply. Off-shape findings are dropped. */
export function parseFindings(text: string, reviewer: string, featureIds: string[]): Finding[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('A reviewer’s reply wasn’t in the expected shape. Try again.');
  }
  const list = (raw as { findings?: unknown }).findings;
  if (!Array.isArray(list)) throw new Error('A reviewer’s reply wasn’t in the expected shape. Try again.');
  const out: Finding[] = [];
  for (const f of list) {
    if (typeof f !== 'object' || f === null) continue;
    const ff = f as Record<string, unknown>;
    const t = typeof ff.text === 'string' ? ff.text.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    if (!t) continue;
    const severity = SEVERITIES.includes(ff.severity as Severity) ? (ff.severity as Severity) : 'should';
    const feature = typeof ff.feature === 'string' && featureIds.includes(ff.feature) ? ff.feature : undefined;
    out.push(feature ? { reviewer, severity, text: t, feature } : { reviewer, severity, text: t });
    if (out.length >= 6) break;
  }
  return out;
}

/** review.md: findings, most serious first. */
export function renderReview(iv: Interview, findings: Finding[], big: boolean, costText: string, now: Date): string {
  const sorted = [...findings].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  const label: Record<Severity, string> = { must: 'Must fix', should: 'Should fix', could: 'Could add' };
  return [
    `# ${iv.name}: plan review`,
    '',
    `Reviewed on ${now.toISOString().slice(0, 10)} by ${big ? `${FRESH_EYES.length} fresh-eyes reviewers (big build)` : 'one plan review'}. Cost: ${costText}.`,
    '',
    ...(sorted.length ? sorted.map((f) => `- **${label[f.severity]}**${f.feature ? ` (${f.feature})` : ''}: ${f.text}`) : ['- No problems found.']),
    '',
  ].join('\n');
}

/**
 * Findings: one shape for every check result.
 *
 * The checks keep their own logic and still report a `CheckResult`; `toFindings` turns each one
 * into this shape so the run record, the Build screen and Keep all read the same thing.
 * Levels, in plain words:
 *  - pass: it ran and found nothing.
 *  - info: it couldn't run, or it's only a note.
 *  - warn: advice. It's shown, but it doesn't stop Keep.
 *  - block: stops Keep (until joshua puts it right, or approves it for new packages).
 * Findings can make the app ask; they never approve anything.
 */
import type { CheckResult } from './index.js';

export const FINDING_LEVELS = ['pass', 'info', 'warn', 'block'] as const;
export type FindingLevel = (typeof FINDING_LEVELS)[number];
/** Who found it: a tool (tests, secretlint...), a model's reading of the code, or a plain rule. */
export const FINDING_SOURCES = ['tool', 'model', 'rule'] as const;
export type FindingSource = (typeof FINDING_SOURCES)[number];

export interface Finding {
  /** Which check found it: 'tests', 'secrets', 'audit', 'dependencies', 'checklist', 'axe', ... */
  check: string;
  level: FindingLevel;
  /** One plain-words line. */
  title: string;
  detail?: string;
  file?: string;
  line?: number;
  source: FindingSource;
}

/** The checks' plain names. */
export const CHECK_TITLES: Record<string, string> = {
  tests: 'Tests',
  secrets: 'Secret scan',
  audit: 'Package audit',
  dependencies: 'New packages',
  checklist: 'Checklist rules',
  'done-list': 'Done list',
  axe: 'Accessibility',
  'phone-overflow': 'Phone width',
  pictures: 'Pictures',
  'free checks': 'Free checks',
};

/** Checks that follow a plain rule of ours; the rest are run by a tool. */
const RULE_CHECKS = new Set(['dependencies', 'checklist']);

const NOT_RUN = /^(Not run|No pictures)/;

/**
 * One check result as one finding.
 *  - passed: pass.
 *  - failed and not advice-only: block (this is exactly what stops Keep today).
 *  - failed, advice-only, and it didn't run ("Not run...", "No pictures..."): info.
 *  - failed, advice-only: warn.
 */
export function toFinding(r: Pick<CheckResult, 'name' | 'passed' | 'advisory' | 'detail'>): Finding {
  const name = CHECK_TITLES[r.name] ?? r.name;
  const detail = r.detail ? { detail: r.detail } : {};
  const source: FindingSource = RULE_CHECKS.has(r.name) ? 'rule' : 'tool';
  if (r.passed) return { check: r.name, level: 'pass', title: `${name}: passed`, ...detail, source };
  if (!r.advisory) {
    const title = r.name === 'dependencies' ? `${name}: need your OK before Keep` : `${name}: failed`;
    return { check: r.name, level: 'block', title, ...detail, source };
  }
  if (NOT_RUN.test(r.detail ?? '')) return { check: r.name, level: 'info', title: `${name}: not run`, ...detail, source };
  return { check: r.name, level: 'warn', title: `${name}: advice (doesn’t stop Keep)`, ...detail, source };
}

/** All the free checks' results as findings, in order. */
export function toFindings(results: Pick<CheckResult, 'name' | 'passed' | 'advisory' | 'detail'>[]): Finding[] {
  return results.map(toFinding);
}

export interface FindingSummary {
  pass: number;
  info: number;
  warn: number;
  block: number;
  /** True when any finding blocks Keep. */
  blocksKeep: boolean;
}

/** Counts per level, and whether Keep is blocked. */
export function summarise(findings: Pick<Finding, 'level'>[]): FindingSummary {
  const s = { pass: 0, info: 0, warn: 0, block: 0 };
  for (const f of findings) s[f.level] += 1;
  return { ...s, blocksKeep: s.block > 0 };
}

/** The names of the checks that block Keep, once each, in the order found. */
export function blockingChecks(findings: Pick<Finding, 'check' | 'level'>[]): string[] {
  return [...new Set(findings.filter((f) => f.level === 'block').map((f) => f.check))];
}

/**
 * Checks run on every build. Free checks first (tests, axe, phone overflow, secretlint, npm audit);
 * Haiku reads changed code for what they miss. Tests must always pass and are never cut.
 */

export interface CheckResult {
  name: string;
  passed: boolean;
  free: boolean;
  detail?: string;
  /** Advice only: shown in the report, but a failure doesn't stop Keep. */
  advisory?: boolean;
}

export const FREE_CHECKS = ['tests', 'axe', 'phone-overflow', 'secretlint', 'npm-audit'] as const;

/** A build may be kept only when every check passed (advice-only checks don't block). */
export function canKeep(results: CheckResult[]): { keep: boolean; blocking: string[] } {
  const blocking = results.filter((r) => !r.passed && !r.advisory).map((r) => r.name);
  const missingTests = !results.some((r) => r.name === 'tests');
  if (missingTests) blocking.unshift('tests (not run)');
  return { keep: blocking.length === 0, blocking };
}

/** Big build = 5+ features, or anything touching logins, payments or personal data: paid and EGM reviews run. */
export function isBigBuild(features: number, touches: { logins?: boolean; payments?: boolean; personalData?: boolean }): boolean {
  return features >= 5 || !!touches.logins || !!touches.payments || !!touches.personalData;
}

export { INSTALL_ARGS, KEEP_OUTPUT, packageManager, projectEnv, realExec, runTests, type Exec, type ExecResult } from './tests.js';

export { CHECKLIST_RULES, MAX_FINDINGS, auditCheck, changedSince, checklistCheck, runFreeChecks, secretScan, type AddedLine, type ChangedFiles } from './free.js';
export { SIZES, browserChoice, freePort, serveCommand, takePictures, type Picture, type PicturesResult, type Serve } from './pictures.js';
export { LivePreview, watchLive, type LiveOptions, type LiveState } from './live.js';
export { CHECK_TOOLS, checkToolUses, checkToolVersions, type CheckTool, type ToolUse } from './versions.js';
export { Blocked, RUBRIC, SUITES, overall, runSuites, type CaseResult, type EvalKind, type EvalResult, type EvalSuite, type Outcome } from './evals.js';
export { browserPaths, checkEnvironment, compareComputers, computerId, versionIn, type EnvCheck, type EnvOptions, type Environment, type Run } from './environment.js';
export { findUpdates, levelOf, parseOutdated, type Level, type RunOut, type UpdateFound } from './updates.js';

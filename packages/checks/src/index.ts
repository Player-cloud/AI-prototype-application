/**
 * Checks run on every build. Free checks first (tests, axe, phone overflow, secretlint, npm audit);
 * Haiku reads changed code for what they miss. Tests must always pass and are never cut.
 */

export interface CheckResult { name: string; passed: boolean; free: boolean; detail?: string }

export const FREE_CHECKS = ['tests', 'axe', 'phone-overflow', 'secretlint', 'npm-audit'] as const;

/** A build may be kept only when every check passed. */
export function canKeep(results: CheckResult[]): { keep: boolean; blocking: string[] } {
  const blocking = results.filter((r) => !r.passed).map((r) => r.name);
  const missingTests = !results.some((r) => r.name === 'tests');
  if (missingTests) blocking.unshift('tests (not run)');
  return { keep: blocking.length === 0, blocking };
}

/** Big build = 5+ features, or anything touching logins, payments or personal data: paid and EGM reviews run. */
export function isBigBuild(features: number, touches: { logins?: boolean; payments?: boolean; personalData?: boolean }): boolean {
  return features >= 5 || !!touches.logins || !!touches.payments || !!touches.personalData;
}

export { KEEP_OUTPUT, packageManager, realExec, runTests, type Exec, type ExecResult } from './tests.js';

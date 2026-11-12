import { describe, expect, it } from 'vitest';
import type { CheckResult } from '@aip/checks';
import { claimLines, compareClaims } from '../src/claims.ts';

const tests = (passed: boolean): CheckResult => ({ name: 'tests', passed, free: true });
const check = (name: string, passed: boolean, extra: Partial<CheckResult> = {}): CheckResult => ({ name, passed, free: true, ...extra });

describe('honest build report', () => {
  it('flags the first real run: the summary said an audit ran, but the app’s audit didn’t', () => {
    const summary = 'Added email login with Auth.js. All 4 tests pass and pnpm audit shows no vulnerabilities.';
    const claims = compareClaims(summary, [
      tests(true),
      check('secrets', true),
      check('audit', false, { advisory: true, detail: 'Not run: ERR_PNPM_EALLOWSCRIPTS' }),
    ]);
    expect(claims).toEqual([
      { topic: 'Tests', agrees: true, note: 'The app checked this itself: passed.' },
      { topic: 'Package audit', agrees: null, note: 'The app’s own check didn’t run (ERR_PNPM_EALLOWSCRIPTS).' },
    ]);
    expect(claimLines(claims)).toEqual([
      '✓ Tests: The app checked this itself: passed.',
      '? Package audit: The app’s own check didn’t run (ERR_PNPM_EALLOWSCRIPTS).',
    ]);
  });

  it('says when the app’s own result disagrees with the model', () => {
    const claims = compareClaims('Tests pass. The page is fully responsive and accessible.', [
      tests(false),
      check('axe', true, { advisory: true }),
      check('phone-overflow', false, { advisory: true }),
    ]);
    expect(claims).toEqual([
      { topic: 'Tests', agrees: false, note: 'The app checked this itself: it failed.' },
      { topic: 'Accessibility', agrees: true, note: 'The app checked this itself: passed.' },
      { topic: 'Phone width', agrees: false, note: 'The app checked this itself: see the notes below (advice, doesn’t stop Keep).' },
    ]);
  });

  it('marks claims the app doesn’t check at all, and lists nothing the summary doesn’t mention', () => {
    expect(compareClaims('Ran tsc and eslint; next build succeeds.', [tests(true)])).toEqual([
      { topic: 'Type check', agrees: null, note: 'The app doesn’t check this itself, so only the model says so.' },
      { topic: 'Lint', agrees: null, note: 'The app doesn’t check this itself, so only the model says so.' },
      { topic: 'Production build', agrees: null, note: 'The app doesn’t check this itself, so only the model says so.' },
    ]);
    expect(compareClaims('Added the rota page.', [tests(true)])).toEqual([]);
    // A secret-scan claim with no secret scan result (for example a stopped run) isn't "passed".
    expect(compareClaims('No secrets committed.', [tests(true)])[0]).toEqual({ topic: 'Secret scan', agrees: null, note: 'The app has no result for this in this build, so only the model says so.' });
  });
});

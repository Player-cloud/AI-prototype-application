import { describe, expect, it } from 'vitest';
import { checkToolUses, checkToolVersions, type CheckResult } from '../src/index.ts';

const r = (name: string, passed: boolean, detail = ''): CheckResult => ({ name, passed, free: true, detail });
const V = { secretlint: '11.7.1', 'axe-core': '4.14.0', playwright: '1.64.1' };

describe('check tool versions (CI-1)', () => {
  it('reads the installed versions of the check tools', () => {
    const v = checkToolVersions();
    expect(Object.keys(v)).toEqual(['secretlint', 'axe-core', 'playwright']);
    for (const x of Object.values(v)) expect(x).toMatch(/^\d+\.\d+\.\d+/);
    // A package that can't be read shows as '' (unknown), never a guess.
    expect(checkToolVersions(() => {
      throw new Error('missing');
    })).toEqual({ secretlint: '', 'axe-core': '', playwright: '' });
  });

  it('counts a check that found problems as the tool working, and one that couldn’t run as failing', () => {
    expect(checkToolUses([r('secrets', false, 'a key'), r('axe', false)], true, V)).toEqual([
      { id: 'secretlint', name: 'secretlint', version: '11.7.1', ok: true },
      { id: 'axe-core', name: 'axe-core', version: '4.14.0', ok: true },
      { id: 'playwright', name: 'Playwright', version: '1.64.1', ok: true },
    ]);
    expect(checkToolUses([r('free checks', false, 'Couldn’t run: boom'), r('pictures', false, 'No pictures: couldn’t open Edge (not found).')], false, V)).toEqual([
      { id: 'secretlint', name: 'secretlint', version: '11.7.1', ok: false, error: 'Couldn’t run: boom' },
      { id: 'playwright', name: 'Playwright', version: '1.64.1', ok: false, error: 'No pictures: couldn’t open Edge (not found).' },
    ]);
    // A page that wouldn't start isn't Playwright's fault, so it isn't counted either way.
    expect(checkToolUses([r('pictures', false, 'No pictures: the page wasn’t ready after 120 seconds.')], false, V)).toEqual([]);
  });
});

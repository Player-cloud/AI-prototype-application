import { describe, expect, it } from 'vitest';
import { canKeep, isBigBuild } from '../src/index.js';

describe('canKeep', () => {
  it('needs every check to pass', () => {
    expect(canKeep([{ name: 'tests', passed: true, free: true }, { name: 'axe', passed: true, free: true }])).toEqual({ keep: true, blocking: [] });
    expect(canKeep([{ name: 'tests', passed: true, free: true }, { name: 'secretlint', passed: false, free: true }]).keep).toBe(false);
  });
  it('never keeps a build whose tests did not run', () => {
    expect(canKeep([{ name: 'axe', passed: true, free: true }])).toEqual({ keep: false, blocking: ['tests (not run)'] });
  });
});

describe('isBigBuild', () => {
  it('follows the agreed rule', () => {
    expect(isBigBuild(5, {})).toBe(true);
    expect(isBigBuild(2, { payments: true })).toBe(true);
    expect(isBigBuild(2, {})).toBe(false);
  });
});

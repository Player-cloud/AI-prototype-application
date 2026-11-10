import { describe, expect, it } from 'vitest';
import { SCREENS, findScreen } from '../src/screens';

describe('screens list', () => {
  it('starts with Projects', () => {
    expect(SCREENS[0]?.id).toBe('projects');
  });

  it('has unique ids', () => {
    const ids = SCREENS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('finds a screen by id and throws on an unknown one', () => {
    expect(findScreen('settings').label).toBe('Settings');
    // @ts-expect-error testing a bad id on purpose
    expect(() => findScreen('nope')).toThrow('Unknown screen');
  });
});

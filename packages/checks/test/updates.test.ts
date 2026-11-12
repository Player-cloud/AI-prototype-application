import { describe, expect, it } from 'vitest';
import { findUpdates, levelOf, parseOutdated } from '../src/index.ts';

const OUTDATED = JSON.stringify({
  vite: { current: '8.3.7', latest: '8.3.8', wanted: '8.3.7', isDeprecated: false, dependentPackages: [{ name: '@aip/desktop' }] },
  '@secretlint/node': { current: '11.7.1', latest: '13.1.0', isDeprecated: false, dependentPackages: [{ name: '@aip/checks' }, { name: '@aip/checks' }] },
  'playwright-core': { current: '1.64.1', latest: '1.65.0', isDeprecated: true, dependentPackages: [{ name: '@aip/checks' }] },
  same: { current: '1.0.0', latest: '1.0.0' },
  broken: { current: 3 },
});

describe('update spotting (CI-6)', () => {
  it('reads pnpm’s list, tracked tools first, and names the size of each update', () => {
    expect(parseOutdated(OUTDATED)).toEqual([
      { package: '@secretlint/node', current: '11.7.1', latest: '13.1.0', level: 'major', deprecated: false, usedBy: ['@aip/checks'], capability: 'secretlint' },
      { package: 'playwright-core', current: '1.64.1', latest: '1.65.0', level: 'minor', deprecated: true, usedBy: ['@aip/checks'], capability: 'playwright' },
      { package: 'vite', current: '8.3.7', latest: '8.3.8', level: 'patch', deprecated: false, usedBy: ['@aip/desktop'], capability: '' },
    ]);
    expect(parseOutdated('')).toEqual([]);
    expect(() => parseOutdated('not json')).toThrow('pnpm’s list of updates couldn’t be read.');
    expect(levelOf('1.2.3', '2.0.0-beta.1')).toBe('major');
    expect(levelOf('latest', '1.0.0')).toBe('unknown');
  });

  it('only looks; it runs pnpm outdated in the app folder and nothing else', async () => {
    const calls: string[][] = [];
    const r = await findUpdates('/app', async (cmd, args, cwd) => {
      calls.push([cmd, ...args, cwd]);
      return OUTDATED;
    });
    expect(calls).toEqual([['pnpm', 'outdated', '-r', '--format', 'json', '/app']]);
    expect(r).toHaveLength(3);
  });
});

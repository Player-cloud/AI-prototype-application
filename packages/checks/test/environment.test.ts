import { describe, expect, it } from 'vitest';
import { browserPaths, checkEnvironment, compareComputers, computerId, versionIn, type Run } from '../src/index.ts';

const NOW = new Date('2026-11-12T10:30:00Z');

/** A computer with the given programs; any other command fails as if it isn't installed. */
const programs = (answers: Record<string, string>): Run => async (cmd, args) => {
  const key = [cmd, ...args].join(' ');
  if (key in answers) return answers[key]!;
  throw new Error(`${cmd}: not found`);
};

describe('checking this computer (CI-2)', () => {
  it('names computers and reads versions out of tool output', () => {
    expect(computerId('LAPTO')).toBe('lapto');
    expect(computerId('Joshu-PC.local')).toBe('joshu-pc-local');
    expect(computerId('!!!')).toBe('this-computer');
    expect(versionIn('v22.12.0')).toBe('22.12.0');
    expect(versionIn('git version 2.47.1.windows.1')).toBe('2.47.1');
    expect(versionIn('nothing')).toBe('');
  });

  it('finds everything fine on a well set-up computer', async () => {
    const env = await checkEnvironment({
      now: NOW,
      name: 'Lapto',
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      exists: async (p) => p.endsWith('msedge.exe'),
      pinned: { packageManager: 'pnpm@10.34.9', node: '>=22' },
      extra: { 'claude-agent-sdk': '0.3.319' },
      run: programs({
        'pnpm --version': '10.34.9',
        'git --version': 'git version 2.47.1.windows.1',
        'git config --global user.name': 'joshua',
        'git config --global user.email': 'j@example.invalid',
      }),
    });
    expect(env).toMatchObject({ computer: 'lapto', checkedAt: NOW.toISOString() });
    expect(env.os).toMatch(/^Windows /);
    expect(env.versions).toMatchObject({ pnpm: '10.34.9', git: '2.47.1', 'claude-agent-sdk': '0.3.319' });
    expect(env.checks.map((c) => [c.name, c.ok])).toEqual([
      ['Node', true],
      ['pnpm', true],
      ['git', true],
      ['git name for commits', true],
      ['Browser for pictures', true],
      ['Check tools', true],
    ]);
  });

  it('says in plain words what to fix', async () => {
    const env = await checkEnvironment({
      now: NOW,
      platform: 'win32',
      env: {},
      exists: async () => false,
      pinned: { packageManager: 'pnpm@10.34.9', node: '>=99' },
      run: programs({ 'pnpm --version': '12.0.1', 'git --version': 'git version 2.47.1' }),
    });
    const by = Object.fromEntries(env.checks.map((c) => [c.name, c]));
    expect(by.Node).toMatchObject({ ok: false });
    expect(by.Node!.detail).toMatch(/too old: the app needs 99 or newer/);
    expect(by.pnpm!.detail).toBe('pnpm 12.0.1 is installed, but the app is pinned to 10.34.9. Run “corepack enable” so the pinned one is used.');
    // The first real run's commits showed the wrong author.
    expect(by['git name for commits']).toMatchObject({ ok: false });
    expect(by['Browser for pictures']).toMatchObject({ ok: false });
    const none = await checkEnvironment({ now: NOW, platform: 'linux', env: {}, exists: async () => false, run: programs({}) });
    expect(none.checks.find((c) => c.name === 'pnpm')!.detail).toMatch(/isn’t installed/);
    expect(none.checks.find((c) => c.name === 'git')!.ok).toBe(false);
    // On Linux a missing Chrome may just be somewhere else, so it's "couldn't tell".
    expect(none.checks.find((c) => c.name === 'Browser for pictures')!.ok).toBeNull();
  });

  it('looks for Edge on Windows, Chrome on Linux, or the browser in AIP_BROWSER', () => {
    expect(browserPaths({ AIP_BROWSER: '/b/chrome' }, 'linux')).toEqual(['/b/chrome']);
    expect(browserPaths({ ProgramFiles: 'C:\\PF' }, 'win32')[0]).toMatch(/Edge.Application.msedge\.exe$/);
    expect(browserPaths({}, 'linux')).toContain('/opt/google/chrome/chrome');
  });

  it('lists versions that differ between computers', () => {
    expect(compareComputers([{ computer: 'joshu', versions: { pnpm: '10.34.9', git: '2.47.1' } }])).toEqual([]);
    expect(
      compareComputers([
        { computer: 'joshu', versions: { pnpm: '10.34.9', git: '2.47.1', node: '22.1.0' } },
        { computer: 'lapto', versions: { pnpm: '10.20.0', git: '2.47.1', node: '' } },
      ]),
    ).toEqual(['pnpm: joshu 10.34.9, lapto 10.20.0']);
  });
});

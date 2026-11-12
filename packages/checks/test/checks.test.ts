import { describe, expect, it } from 'vitest';
import { canKeep, isBigBuild, projectEnv } from '../src/index.js';

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

describe('runTests', () => {
  it('needs a package.json with a test script', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { runTests } = await import('../src/index.js');
    const dir = await mkdtemp(join(tmpdir(), 'aip-checks-'));
    try {
      const never = async () => {
        throw new Error('should not run');
      };
      expect((await runTests(dir, never)).detail).toContain('No package.json');
      await writeFile(join(dir, 'package.json'), '{"scripts": {}}');
      expect(await runTests(dir, never)).toEqual({ name: 'tests', passed: false, free: true, detail: 'package.json has no "test" script. Add tests and a test script.' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('installs with the project’s package manager when needed, then runs the tests', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { runTests, KEEP_OUTPUT } = await import('../src/index.js');
    const dir = await mkdtemp(join(tmpdir(), 'aip-checks-'));
    try {
      await writeFile(join(dir, 'package.json'), '{"scripts": {"test": "vitest run"}}');
      await writeFile(join(dir, 'package-lock.json'), '{}');
      const ran: string[] = [];
      const pass = async (cmd: string, args: string[]) => {
        ran.push(`${cmd} ${args.join(' ')}`);
        return { code: 0, output: 'Tests 3 passed' };
      };
      expect(await runTests(dir, pass)).toEqual({ name: 'tests', passed: true, free: true, detail: 'Tests 3 passed' });
      expect(ran).toEqual(['npm install --ignore-scripts', 'npm test -- --reporter=verbose']);

      await mkdir(join(dir, 'node_modules'));
      ran.length = 0;
      const fail = async (cmd: string, args: string[]) => {
        ran.push(`${cmd} ${args.join(' ')}`);
        return { code: 1, output: `${'x'.repeat(KEEP_OUTPUT + 50)}\n1 failed` };
      };
      const r = await runTests(dir, fail);
      expect(ran).toEqual(['npm test -- --reporter=verbose']);
      expect(r.passed).toBe(false);
      expect(r.detail?.endsWith('1 failed')).toBe(true);
      expect(r.detail?.length).toBeLessThanOrEqual(KEEP_OUTPUT + 1);

      const badInstall = async () => ({ code: 1, output: 'ERR! network' });
      await rm(join(dir, 'node_modules'), { recursive: true });
      expect((await runTests(dir, badInstall)).detail).toBe('Installing packages failed:\nERR! network');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('installs without running package scripts, for every package manager', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { runTests } = await import('../src/index.js');
    for (const [lock, pm] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm'], [null, 'pnpm']] as const) {
      const dir = await mkdtemp(join(tmpdir(), 'aip-checks-'));
      try {
        await writeFile(join(dir, 'package.json'), '{"scripts": {"test": "vitest run"}}');
        if (lock) await writeFile(join(dir, lock), '');
        const ran: string[][] = [];
        await runTests(dir, async (cmd, args) => {
          ran.push([cmd, ...args]);
          return { code: 0, output: '' };
        });
        expect(ran[0]).toEqual([pm, 'install', '--ignore-scripts']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('really installs without running a package’s postinstall script', async () => {
    const { mkdtemp, mkdir, writeFile, rm, access } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { realExec, INSTALL_ARGS } = await import('../src/index.js');
    const dir = await mkdtemp(join(tmpdir(), 'aip-checks-'));
    try {
      await mkdir(join(dir, 'dep'));
      const marker = join(dir, 'dep', 'MARKER.txt');
      await writeFile(join(dir, 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0', scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'MARKER.txt\',\'ran\')"' } }));
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { dep: 'file:./dep' } }));
      const r = await realExec('npm', [...INSTALL_ARGS, '--offline', '--no-audit', '--no-fund'], dir, 60_000);
      expect(r.code, r.output).toBe(0);
      await access(join(dir, 'node_modules', 'dep')); // it really installed
      const exists = await access(marker).then(() => true, () => false);
      const exists2 = await access(join(dir, 'node_modules', 'dep', 'MARKER.txt')).then(() => true, () => false);
      expect(exists || exists2).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('really runs a command and reports its exit code', async () => {
    const { realExec } = await import('../src/index.js');
    // No quotes or spaces in the script: on Windows it goes through the shell.
    const ok = await realExec('node', ['-e', 'process.stdout.write(String(6*7))'], process.cwd(), 30_000);
    expect(ok).toEqual({ code: 0, output: '42' });
    const bad = await realExec('node', ['-e', 'process.exit(3)'], process.cwd(), 30_000);
    expect(bad.code).toBe(3);
  });
});

describe('the project’s own package manager', () => {
  it('doesn’t get the app’s own pnpm settings', () => {
    const env = projectEnv({ CI: '1' }, { PATH: '/bin', npm_config_allow_scripts: 'x', npm_package_name: 'aip', PNPM_HOME: '/p', pnpm_config_verify_deps_before_run: 'false', HOME: '/h' });
    expect(env).toEqual({ PATH: '/bin', PNPM_HOME: '/p', HOME: '/h', CI: '1' });
  });
});

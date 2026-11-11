/**
 * Step 8d: runs a project's own tests in a build's copy of the code. Uses the package manager the
 * project uses (from its lock file), installs packages first if the copy has none, and keeps the
 * end of the output for the report and for fix attempts. Tests must pass; they're never skipped.
 */
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckResult } from './index.js';

export interface ExecResult { code: number; output: string }
export type Exec = (cmd: string, args: string[], cwd: string, timeoutMs: number) => Promise<ExecResult>;

/** Longest output kept (the end of it, where test runners put their summary). */
export const KEEP_OUTPUT = 3000;
const TEN_MINUTES = 10 * 60_000;

export const realExec: Exec = (cmd, args, cwd, timeoutMs) =>
  new Promise((resolve) => {
    // pnpm/npm/yarn are .cmd files on Windows, which need a shell. The arguments here are fixed.
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, shell: process.platform === 'win32', env: { ...process.env, CI: '1' }, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = `${stdout}${stderr}`;
        if (!err) return resolve({ code: 0, output });
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        if (e.killed) return resolve({ code: 124, output: `${output}\nStopped: took longer than ${Math.round(timeoutMs / 60_000)} minutes.` });
        resolve({ code: typeof e.code === 'number' ? e.code : 1, output: output || e.message });
      },
    );
  });

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/** pnpm, yarn or npm, from the lock file (pnpm when there's none: the standard stack). */
export async function packageManager(dir: string): Promise<'pnpm' | 'yarn' | 'npm'> {
  if (await exists(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(join(dir, 'yarn.lock'))) return 'yarn';
  if (await exists(join(dir, 'package-lock.json'))) return 'npm';
  return 'pnpm';
}

const tail = (t: string) => (t.length > KEEP_OUTPUT ? `…${t.slice(-KEEP_OUTPUT)}` : t).trim();

export async function runTests(dir: string, exec: Exec = realExec): Promise<CheckResult> {
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as typeof pkg;
  } catch {
    return { name: 'tests', passed: false, free: true, detail: 'No package.json, so there are no tests to run. Add the project and its tests.' };
  }
  if (!pkg.scripts?.test) return { name: 'tests', passed: false, free: true, detail: 'package.json has no "test" script. Add tests and a test script.' };
  const pm = await packageManager(dir);
  if (!(await exists(join(dir, 'node_modules')))) {
    const install = await exec(pm, ['install'], dir, TEN_MINUTES);
    if (install.code !== 0) return { name: 'tests', passed: false, free: true, detail: `Installing packages failed:\n${tail(install.output)}` };
  }
  const r = await exec(pm, ['test'], dir, TEN_MINUTES);
  return { name: 'tests', passed: r.code === 0, free: true, detail: tail(r.output) };
}

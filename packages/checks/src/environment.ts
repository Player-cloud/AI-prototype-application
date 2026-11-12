/**
 * CI-2: does this computer have what the app needs, at versions that fit together? A free check
 * (no model, nothing downloaded): Node, pnpm against the pinned version, git and its name for
 * commits, a browser for pictures, and the check tools' versions. Each computer's result is saved
 * in the data repo, so joshua can see his PC and laptop side by side.
 */
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { hostname, platform as osPlatform, release } from 'node:os';
import { join } from 'node:path';
import { checkToolVersions } from './versions.js';

export interface EnvCheck {
  name: string;
  /** true: fine. false: needs fixing. null: couldn't tell. */
  ok: boolean | null;
  detail: string;
}

export interface Environment {
  /** Stable ID for this computer: its name as a slug. */
  computer: string;
  checkedAt: string;
  os: string;
  /** Versions found, '' when missing. */
  versions: Record<string, string>;
  checks: EnvCheck[];
}

/** Runs a program and gives back its output, or throws when it isn't there or fails. */
export type Run = (cmd: string, args: string[]) => Promise<string>;

const realRun: Run = (cmd, args) =>
  new Promise((res, rej) =>
    execFile(cmd, args, { timeout: 15_000, windowsHide: true, shell: process.platform === 'win32' }, (err, out) => (err ? rej(err) : res(String(out).trim()))),
  );

export function computerId(name = hostname()): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'this-computer'
  );
}

/** "22.12.0" from "v22.12.0" or "git version 2.47.1.windows.1". */
export function versionIn(text: string): string {
  return text.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? '';
}

const major = (v: string) => Number(v.split('.')[0] ?? NaN);

/** Where Edge or Chrome usually live; AIP_BROWSER wins when set. */
export function browserPaths(env: NodeJS.ProcessEnv, platform: string): string[] {
  if (env.AIP_BROWSER) return [env.AIP_BROWSER];
  if (platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter((r): r is string => !!r);
    return roots.map((r) => join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  return ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
}

export interface EnvOptions {
  run?: Run;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  now?: Date;
  name?: string;
  /** The app's pinned package manager ("pnpm@10.34.9") and Node range (">=22"). */
  pinned?: { packageManager?: string; node?: string };
  exists?: (path: string) => Promise<boolean>;
  /** Extra versions the caller knows (for example the Claude Agent SDK). */
  extra?: Record<string, string>;
}

const realExists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

export async function checkEnvironment(opts: EnvOptions = {}): Promise<Environment> {
  const run = opts.run ?? realRun;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? osPlatform();
  const exists = opts.exists ?? realExists;
  const tryRun = async (cmd: string, args: string[]) => run(cmd, args).catch(() => null);
  const checks: EnvCheck[] = [];
  const versions: Record<string, string> = { ...checkToolVersions(), ...opts.extra };

  // Node runs the app's engine.
  const node = versionIn(process.version);
  versions.node = node;
  const needNode = Number((opts.pinned?.node ?? '>=22').match(/\d+/)?.[0] ?? 22);
  checks.push(
    major(node) >= needNode
      ? { name: 'Node', ok: true, detail: `Node ${node} (needs ${needNode} or newer).` }
      : { name: 'Node', ok: false, detail: `Node ${node} is too old: the app needs ${needNode} or newer.` },
  );

  // pnpm: the same major version as the one pinned, or installs can differ between computers.
  const pinnedPnpm = versionIn(opts.pinned?.packageManager ?? '');
  const pnpm = versionIn((await tryRun('pnpm', ['--version'])) ?? '');
  versions.pnpm = pnpm;
  if (!pnpm) checks.push({ name: 'pnpm', ok: false, detail: 'pnpm isn’t installed or can’t be found. Run “corepack enable” once.' });
  else if (pinnedPnpm && major(pnpm) !== major(pinnedPnpm)) {
    checks.push({ name: 'pnpm', ok: false, detail: `pnpm ${pnpm} is installed, but the app is pinned to ${pinnedPnpm}. Run “corepack enable” so the pinned one is used.` });
  } else checks.push({ name: 'pnpm', ok: true, detail: `pnpm ${pnpm}${pinnedPnpm ? ` (pinned: ${pinnedPnpm})` : ''}.` });

  // git, and a name for commits (the first real run's commits showed the wrong author).
  const git = versionIn((await tryRun('git', ['--version'])) ?? '');
  versions.git = git;
  if (!git) checks.push({ name: 'git', ok: false, detail: 'git isn’t installed or can’t be found.' });
  else {
    const user = (await tryRun('git', ['config', '--global', 'user.name'])) ?? '';
    const email = (await tryRun('git', ['config', '--global', 'user.email'])) ?? '';
    checks.push({ name: 'git', ok: true, detail: `git ${git}.` });
    checks.push(
      user && email
        ? { name: 'git name for commits', ok: true, detail: `Set (commits show “${user}”).` }
        : { name: 'git name for commits', ok: false, detail: 'Not set. Run git config --global user.name "Your Name" and user.email once.' },
    );
  }

  // A browser for the pictures and accessibility check.
  const found: string[] = [];
  for (const p of browserPaths(env, platform)) if (await exists(p)) found.push(p);
  const label = platform === 'win32' ? 'Edge' : 'Chrome';
  checks.push(
    found.length
      ? { name: 'Browser for pictures', ok: true, detail: `${env.AIP_BROWSER ? 'The browser in AIP_BROWSER' : label} found.` }
      : { name: 'Browser for pictures', ok: platform === 'win32' ? false : null, detail: `${label} wasn’t found where it usually is. Pictures may not work; set AIP_BROWSER to a browser’s full path.` },
  );

  // The check tools come with the app; a missing one means its packages aren't installed.
  const missing = ['secretlint', 'axe-core', 'playwright'].filter((t) => !versions[t]);
  checks.push(
    missing.length
      ? { name: 'Check tools', ok: false, detail: `${missing.join(', ')} can’t be found. Run pnpm install in the app folder.` }
      : { name: 'Check tools', ok: true, detail: `secretlint ${versions.secretlint}, axe-core ${versions['axe-core']}, Playwright ${versions.playwright}.` },
  );

  return {
    computer: computerId(opts.name),
    checkedAt: (opts.now ?? new Date()).toISOString(),
    os: `${platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : platform} ${release()}`,
    versions,
    checks,
  };
}

/**
 * Versions that differ between computers, for the tools both have: "pnpm: joshu 10.34.9, lapto
 * 10.20.0". Not a fault in itself, but the likeliest reason a build works on one and not the other.
 */
export function compareComputers(envs: Pick<Environment, 'computer' | 'versions'>[]): string[] {
  if (envs.length < 2) return [];
  const names = [...new Set(envs.flatMap((e) => Object.keys(e.versions)))].sort();
  const out: string[] = [];
  for (const n of names) {
    const seen = envs
      .filter((e) => e.versions[n])
      .map((e) => [e.computer, e.versions[n]!] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    if (seen.length > 1 && new Set(seen.map(([, v]) => v)).size > 1) out.push(`${n}: ${seen.map(([c, v]) => `${c} ${v}`).join(', ')}`);
  }
  return out;
}

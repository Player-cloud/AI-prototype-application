/**
 * CI-6: update spotting. A free look-up of newer versions of the app's own packages, with
 * `pnpm outdated` (the same registry pnpm install already uses; only package names are sent).
 * It installs nothing and changes no file: an update found is not an update installed.
 */
import { execFile } from 'node:child_process';
import { CHECK_TOOLS } from './versions.js';

export type Level = 'patch' | 'minor' | 'major' | 'unknown';

export interface UpdateFound {
  package: string;
  current: string;
  latest: string;
  level: Level;
  deprecated: boolean;
  /** The app's own packages that use it, e.g. "@aip/checks". */
  usedBy: string[];
  /** The capability's ID when it's one the app tracks (a check tool, or the Agent SDK). */
  capability: string;
}

/** Packages that are capabilities the app tracks, by package name. */
const CAPABILITY: Record<string, string> = {
  ...Object.fromEntries(CHECK_TOOLS.map((t) => [t.pkg, t.id])),
  '@anthropic-ai/claude-agent-sdk': 'claude-agent-sdk',
};

const parts = (v: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1).map(Number);

export function levelOf(from: string, to: string): Level {
  const [a, b] = [parts(from), parts(to)];
  if (a.length !== 3 || b.length !== 3) return 'unknown';
  if (b[0]! !== a[0]!) return 'major';
  if (b[1]! !== a[1]!) return 'minor';
  return b[2]! !== a[2]! ? 'patch' : 'unknown';
}

/** Reads `pnpm outdated --format json`. Bad input gives no updates, never a guess. */
export function parseOutdated(json: string): UpdateFound[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json || '{}');
  } catch {
    throw new Error('pnpm’s list of updates couldn’t be read.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const out: UpdateFound[] = [];
  for (const [name, v] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
    const current = typeof v?.current === 'string' ? v.current : '';
    const latest = typeof v?.latest === 'string' ? v.latest : '';
    if (!current || !latest || current === latest) continue;
    const users = Array.isArray(v.dependentPackages) ? (v.dependentPackages as { name?: unknown }[]).map((d) => (typeof d?.name === 'string' ? d.name : '')).filter(Boolean) : [];
    out.push({ package: name, current, latest, level: levelOf(current, latest), deprecated: v.isDeprecated === true, usedBy: [...new Set(users)].sort(), capability: CAPABILITY[name] ?? '' });
  }
  return out.sort((a, b) => (b.capability ? 1 : 0) - (a.capability ? 1 : 0) || a.package.localeCompare(b.package));
}

/** Runs a program; gives back its output even when it exits with 1 (pnpm does when updates exist). */
export type RunOut = (cmd: string, args: string[], cwd: string) => Promise<string>;

const realRun: RunOut = (cmd, args, cwd) =>
  new Promise((res, rej) =>
    execFile(cmd, args, { cwd, timeout: 120_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true, shell: process.platform === 'win32' }, (err, out, errOut) => {
      if (String(out).trim().startsWith('{')) return res(String(out));
      if (err) return rej(new Error((String(errOut).trim().split('\n')[0] || err.message).slice(0, 300)));
      res(String(out));
    }),
  );

/** Newer versions of the app's packages. Free; installs nothing. */
export async function findUpdates(appDir: string, run: RunOut = realRun): Promise<UpdateFound[]> {
  return parseOutdated(await run('pnpm', ['outdated', '-r', '--format', 'json'], appDir));
}

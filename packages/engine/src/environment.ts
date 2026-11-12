/**
 * CI-2: compatibility per computer. "Check this computer" runs the free environment check (in
 * @aip/checks), saves the result in the data repo as environments/<computer>.json so both of
 * joshua's computers can be compared, and syncs. Nothing is installed or changed on the computer.
 */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Environment } from '@aip/checks';
import type { AppSettings } from './settings.ts';

/** The app's own pins: the package manager and Node range from its package.json. */
async function appPins(): Promise<{ packageManager?: string; node?: string }> {
  try {
    const pkg = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as { packageManager?: string; engines?: { node?: string } };
    return { packageManager: pkg.packageManager, node: pkg.engines?.node };
  } catch {
    return { packageManager: 'pnpm@10', node: '>=22' };
  }
}

/** The Claude Agent SDK's version, which the build model runs through. '' when it can't be read. */
function agentSdkVersion(): string {
  const name = '@anthropic-ai/claude-agent-sdk';
  try {
    // Its package.json isn't exported, so find it from the package's entry file.
    let dir = dirname(createRequire(createRequire(import.meta.url).resolve('@aip/models')).resolve(name));
    for (let i = 0; i < 6; i += 1) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
        if (pkg.name === name) return pkg.version ?? '';
      } catch {
        // keep looking
      }
      dir = dirname(dir);
    }
  } catch {
    // not installed
  }
  return '';
}

const envPath = (folder: string, computer: string) => join(folder, 'environments', `${computer}.json`);

/** Every computer's last check, newest first. A damaged file is skipped. */
export async function readEnvironments(folder: string): Promise<Environment[]> {
  let files: string[] = [];
  try {
    files = (await readdir(join(folder, 'environments'))).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Environment[] = [];
  for (const f of files) {
    try {
      const e = JSON.parse(await readFile(join(folder, 'environments', f), 'utf8')) as Environment;
      if (typeof e.computer === 'string' && Array.isArray(e.checks) && typeof e.versions === 'object') out.push(e);
    } catch {
      // skipped
    }
  }
  return out.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
}

export interface EnvironmentReport {
  environment: Environment;
  /** Versions that differ between joshua's computers. */
  differences: string[];
  /** How saving to the data repo went ('' with no data folder). */
  synced: string;
}

/** Settings → Tools → Check this computer. Free. */
export async function environmentCheck(settings: AppSettings, now = new Date(), opts: { check?: typeof import('@aip/checks').checkEnvironment } = {}): Promise<EnvironmentReport> {
  const c = await import('@aip/checks');
  const check = opts.check ?? c.checkEnvironment;
  const sdk = agentSdkVersion();
  const environment = await check({ now, pinned: await appPins(), extra: sdk ? { 'claude-agent-sdk': sdk } : {} });
  if (!settings.dataFolder) return { environment, differences: [], synced: '' };
  const m = await import('@aip/memory');
  if (m.looksLikeKey(JSON.stringify(environment))) throw new Error('The check found something that looks like a key, so it wasn’t saved.');
  const path = envPath(settings.dataFolder, environment.computer);
  await mkdir(join(settings.dataFolder, 'environments'), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(environment, null, 2)}\n`);
  await rename(temp, path);
  const differences = c.compareComputers(await readEnvironments(settings.dataFolder));
  let synced: string;
  try {
    synced = (await m.syncDataRepo(settings.dataFolder, `Check computer ${environment.computer}`)).summary;
  } catch (err) {
    synced = `Saved here, but not synced yet: ${(err as Error).message}`;
  }
  return { environment, differences, synced };
}

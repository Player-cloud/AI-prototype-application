/**
 * CI-1: the versions of the free-check tools in use, so the app notices when one updates. A new
 * version marks the tool's old test evidence stale; its next good run clears that (D-2). IDs are
 * the tools' card file names in the data repo.
 */
import { createRequire } from 'node:module';
import type { CheckResult } from './index.js';

export interface CheckTool {
  /** Stable ID: the tool's card file name. */
  id: string;
  /** Its name in plain words. */
  name: string;
  /** The package whose version is the tool's version. */
  pkg: string;
}

export const CHECK_TOOLS: readonly CheckTool[] = [
  { id: 'secretlint', name: 'secretlint', pkg: '@secretlint/node' },
  { id: 'axe-core', name: 'axe-core', pkg: 'axe-core' },
  { id: 'playwright', name: 'Playwright', pkg: 'playwright-core' },
];

/** The installed version of each check tool; '' when it can't be read. */
export function checkToolVersions(resolve: (pkg: string) => unknown = createRequire(import.meta.url)): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of CHECK_TOOLS) {
    try {
      const v = (resolve(`${t.pkg}/package.json`) as { version?: unknown }).version;
      out[t.id] = typeof v === 'string' ? v : '';
    } catch {
      out[t.id] = '';
    }
  }
  return out;
}

export interface ToolUse { id: string; name: string; version: string; ok: boolean; error?: string }

/**
 * Which check tools ran in a build, and whether they worked. A check that finds a problem still
 * worked; a check that couldn't run didn't. Tools that weren't reached are left out (unknown).
 */
export function checkToolUses(checks: CheckResult[], picturesTaken: boolean, versions: Record<string, string>): ToolUse[] {
  const uses: ToolUse[] = [];
  const tool = (id: string) => CHECK_TOOLS.find((t) => t.id === id)!;
  const add = (id: string, ok: boolean, error?: string) => uses.push({ id, name: tool(id).name, version: versions[id] ?? '', ok, ...(error ? { error } : {}) });
  const secrets = checks.find((c) => c.name === 'secrets');
  if (secrets) add('secretlint', true);
  const broken = checks.find((c) => c.name === 'free checks');
  if (!secrets && broken) add('secretlint', false, broken.detail ?? 'The free checks couldn’t run.');
  if (checks.some((c) => c.name === 'axe')) add('axe-core', true);
  if (picturesTaken) add('playwright', true);
  else {
    const why = checks.find((c) => c.name === 'pictures')?.detail ?? '';
    // Only the browser not opening is Playwright's own failure; a page that won't start isn't.
    if (/couldn’t open/.test(why)) add('playwright', false, why);
  }
  return uses;
}

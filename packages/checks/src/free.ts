/**
 * Step 9b: the free checks after a build, in the build's own copy. No model and no cost.
 *  - secrets: secretlint on every file the build added or changed, and no key files (.env, *.pem).
 *  - audit: the package manager's audit; high or critical problems stop Keep.
 *  - dependencies: packages the build added to any package.json. They need joshua's OK before
 *    Keep, so this stops Keep until he approves them (a changed version of a package already there
 *    doesn't count as new).
 *  - checklist: simple rules for the enterprise checklist areas the project ticked, on the lines
 *    the build added. These are advice: they're reported but don't stop Keep.
 */
import { access, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { CheckResult } from './index.js';
import { packageManager, realExec, type Exec } from './tests.js';

const FIVE_MINUTES = 5 * 60_000;
/** Most findings listed per check. */
export const MAX_FINDINGS = 20;

export interface ChangedFiles { files: string[]; added: AddedLine[] }
export interface AddedLine { file: string; line: number; text: string }

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

const lines = (t: string) => t.split(/\r?\n/).filter(Boolean);

/** Files the build changed or added since `base` (committed or not), and the lines it added. */
export async function changedSince(dir: string, base: string, exec: Exec = realExec): Promise<ChangedFiles> {
  const tracked = await exec('git', ['diff', '--name-only', base], dir, FIVE_MINUTES);
  const untracked = await exec('git', ['ls-files', '--others', '--exclude-standard'], dir, FIVE_MINUTES);
  if (tracked.code !== 0) throw new Error(`Couldn’t list the build’s changes: ${tracked.output.trim()}`);
  const newFiles = lines(untracked.output);
  const files = [...new Set([...lines(tracked.output), ...newFiles])];
  const added: AddedLine[] = [];
  const diff = await exec('git', ['diff', '-U0', '--no-color', base], dir, FIVE_MINUTES);
  let file = '';
  let at = 0;
  for (const l of diff.output.split(/\r?\n/)) {
    if (l.startsWith('+++ ')) file = l.startsWith('+++ b/') ? l.slice(6) : '';
    else if (l.startsWith('@@')) at = Number(/\+(\d+)/.exec(l)?.[1] ?? 0);
    else if (l.startsWith('+') && file) added.push({ file, line: at++, text: l.slice(1) });
  }
  for (const f of newFiles) {
    try {
      (await readFile(join(dir, f), 'utf8')).split(/\r?\n/).forEach((text, i) => added.push({ file: f, line: i + 1, text }));
    } catch {
      // unreadable or deleted again: nothing to check
    }
  }
  return { files, added };
}

export const KEY_FILE = /^(\.env(\..+)?|.+\.pem|.+\.key|id_rsa|id_ed25519)$/i;

/** secretlint, the same rules this repo's own `pnpm secrets` uses. Secret values are never shown. */
export async function secretScan(dir: string, files: string[]): Promise<CheckResult> {
  const keyFiles = files.filter((f) => KEY_FILE.test(basename(f)) && !/\.example$/i.test(f));
  const present: string[] = [];
  for (const f of files) if (await exists(join(dir, f))) present.push(join(dir, f));
  let output = '';
  if (present.length) {
    const { createEngine } = await import('@secretlint/node');
    const engine = await createEngine({
      cwd: dir,
      formatter: 'stylish',
      color: false,
      maskSecrets: true,
      configFileJSON: { rules: [{ id: '@secretlint/secretlint-rule-preset-recommend' }] },
    });
    const r = await engine.executeOnFiles({ filePathList: present });
    if (!r.ok) output = r.output.split(dir).join('.').trim();
  }
  const problems = [...keyFiles.map((f) => `${f}: key files must never be added to the code.`), ...(output ? [output] : [])];
  return {
    name: 'secrets',
    passed: problems.length === 0,
    free: true,
    detail: problems.length ? problems.join('\n') : `No keys found in ${files.length} changed file${files.length === 1 ? '' : 's'}.`,
  };
}

/** The package manager's audit. High or critical problems fail; if it can't run, that's reported as advice. */
export async function auditCheck(dir: string, exec: Exec = realExec): Promise<CheckResult> {
  if (!(await exists(join(dir, 'package.json')))) return { name: 'audit', passed: true, free: true, advisory: true, detail: 'No package.json, so there’s nothing to audit.' };
  const pm = await packageManager(dir);
  if (pm === 'yarn') return { name: 'audit', passed: false, free: true, advisory: true, detail: 'Not run: yarn projects aren’t audited yet.' };
  const args = pm === 'pnpm' ? ['audit', '--audit-level', 'high'] : ['audit', '--audit-level=high'];
  const r = await exec(pm, args, dir, FIVE_MINUTES);
  const out = r.output.trim();
  const tail = out.length > 2000 ? `…${out.slice(-2000)}` : out;
  if (r.code === 0) return { name: 'audit', passed: true, free: true, detail: tail || 'No high or critical problems.' };
  // A real finding names a severity; anything else (no internet, registry down) is "not run".
  if (/\b(high|critical)\b/i.test(out) && !/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ERR_PNPM_AUDIT_BAD_RESPONSE/i.test(out)) {
    return { name: 'audit', passed: false, free: true, detail: tail };
  }
  return { name: 'audit', passed: false, free: true, advisory: true, detail: `Not run: ${tail.split('\n').slice(-3).join(' ') || 'the audit didn’t answer.'}` };
}

interface Rule { area: string; test: RegExp; says: string; files?: RegExp }

const CODE = /\.(m?[jt]sx?|vue|svelte|html?|css|scss)$/i;

/** Plain rules for the enterprise checklist areas, run on the lines a build added. */
export const CHECKLIST_RULES: Rule[] = [
  { area: 'Security', test: /\beval\s*\(|new Function\s*\(/, says: 'Don’t run text as code (eval).' },
  { area: 'Security', test: /dangerouslySetInnerHTML|\.innerHTML\s*=/, says: 'Putting raw HTML on the page can let attackers in; use text, or clean the HTML first.' },
  { area: 'Security', test: /['"`]http:\/\/(?!localhost|127\.0\.0\.1)/, says: 'Use https:// links.' },
  { area: 'Logins and accounts', test: /localStorage\.setItem\([^)]*(token|password|session)/i, says: 'Don’t keep login tokens or passwords in localStorage.' },
  { area: 'Logins and accounts', test: /console\.(log|info|debug)\([^)]*password/i, says: 'Never log passwords.' },
  { area: 'Personal data and privacy', test: /console\.(log|info|debug)\([^)]*\b(email|phone|address|dateOfBirth|dob)\b/i, says: 'Don’t log personal data.' },
  { area: 'Payments', test: /\b(cvc|cvv|cardNumber)\b/i, says: 'Card details should only go to the payment provider’s own fields, never through or into your code.' },
  { area: 'Accessibility', test: /<img(?![^>]*\balt=)[^>]*>/i, says: 'Every image needs alt text.', files: /\.(jsx|tsx|html?|vue|svelte)$/i },
  { area: 'Accessibility', test: /<div(?![^>]*\brole=)[^>]*\bonClick=/, says: 'Use a button for things people click, not a div.', files: /\.(jsx|tsx)$/i },
  { area: 'Errors and empty states', test: /catch\s*(\(\s*\w*\s*\))?\s*\{\s*\}/, says: 'Don’t hide errors with an empty catch; show or log a plain message.' },
  { area: 'Phone and desktop layout', test: /(?<![-\w])(min-)?width\s*:\s*(\d{4,}|[5-9]\d\d)px/i, says: 'A fixed width of 500px or more won’t fit a phone; use max-width or %.', files: /\.(css|scss|html?|jsx|tsx|vue|svelte)$/i },
];

/** The checklist rules for the ticked areas. Advice only: findings don't stop Keep. */
export function checklistCheck(areas: string[], added: AddedLine[]): CheckResult {
  const rules = CHECKLIST_RULES.filter((r) => areas.includes(r.area));
  if (rules.length === 0) return { name: 'checklist', passed: true, free: true, advisory: true, detail: 'No checklist rules for the areas this project ticked.' };
  const found: string[] = [];
  for (const l of added) {
    if (!CODE.test(l.file)) continue;
    for (const r of rules) {
      if (r.files && !r.files.test(l.file)) continue;
      if (r.test.test(l.text)) found.push(`${l.file}:${l.line} (${r.area}): ${r.says}`);
    }
  }
  const checked = new Set(rules.map((r) => r.area)).size;
  const shown = found.slice(0, MAX_FINDINGS);
  if (found.length > shown.length) shown.push(`…and ${found.length - shown.length} more.`);
  return {
    name: 'checklist',
    passed: found.length === 0,
    free: true,
    advisory: true,
    detail: found.length ? shown.join('\n') : `Checked ${checked} area${checked === 1 ? '' : 's'}: nothing found.`,
  };
}

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

/** Every package a package.json lists, once by name: its version range and the section it is in. */
function listedPackages(text: string | null): Map<string, { range: string; section: string }> {
  const out = new Map<string, { range: string; section: string }>();
  if (text === null) return out;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return out;
  }
  for (const section of DEP_SECTIONS) {
    const list = json?.[section];
    if (!list || typeof list !== 'object') continue;
    for (const [name, range] of Object.entries(list as Record<string, unknown>)) {
      if (!out.has(name)) out.set(name, { range: String(range), section });
    }
  }
  return out;
}

/** The line that starts each new package in the detail (the approval reads these back). */
export const NEW_PACKAGE = 'New: ';
export const NEEDS_OK = 'New packages need your OK before Keep.';

/**
 * New packages in any package.json of the copy (root and workspace packages), compared with the
 * same file at `base`. A file that wasn't there at base counts as all new. New packages fail this
 * check and it isn't advice, so Keep is stopped until joshua approves them.
 */
export async function dependenciesCheck(dir: string, base: string, files: string[], exec: Exec = realExec): Promise<CheckResult> {
  const manifests = files.filter((f) => /(^|\/)package\.json$/.test(f) && !/(^|\/)node_modules\//.test(f));
  const added: string[] = [];
  const changed: string[] = [];
  for (const file of manifests.sort()) {
    let now: string | null = null;
    try {
      now = await readFile(join(dir, file), 'utf8');
    } catch {
      continue; // deleted by the build: nothing new
    }
    const before = await exec('git', ['show', `${base}:${file}`], dir, FIVE_MINUTES);
    const was = listedPackages(before.code === 0 ? before.output : null);
    for (const [name, { range, section }] of listedPackages(now)) {
      const old = was.get(name);
      if (!old) added.push(`${NEW_PACKAGE}${name} ${range} (${section} in ${file})`);
      else if (old.range !== range) changed.push(`Changed: ${name} ${old.range} → ${range} (${file})`);
    }
  }
  const lines = [...added, ...changed];
  if (added.length === 0) {
    return { name: 'dependencies', passed: true, free: true, detail: ['No new packages.', ...changed].join('\n') };
  }
  return { name: 'dependencies', passed: false, free: true, detail: [...lines, NEEDS_OK].join('\n') };
}

/** All free checks for one build. */
export async function runFreeChecks(dir: string, base: string, areas: string[], exec: Exec = realExec): Promise<CheckResult[]> {
  const changed = await changedSince(dir, base, exec);
  return [await secretScan(dir, changed.files), await auditCheck(dir, exec), await dependenciesCheck(dir, base, changed.files, exec), checklistCheck(areas, changed.added)];
}

/**
 * Q-5, narrow self-maintenance: the app may PREPARE one kind of update itself, and nothing else.
 *   - a dev-tool PATCH update: a devDependency (never dependencies, peer or optional), same major and
 *     minor, higher patch, exact x.y.z (pre-releases, odd ranges and git/url/file specs are refused);
 *   - in a project's own code folder, one update at a time, each in its own git worktree and branch
 *     (like a build), installed with --ignore-scripts, then the project's tests and the free checks;
 *   - green means: local checks pass AND, if GitHub's status for the branch can be read, it is green too.
 * If anything fails the worktree and branch are removed and the failure is recorded: nothing reaches
 * joshua's branch. If everything is green it is NOT merged: it waits as a build-like item (in the
 * Build screen) that joshua Keeps with one click, and Undo works like for any kept build (a new commit).
 * Off by default (settings.maintenance.patchUpdates). When off, nothing runs. Never pushes. At most
 * MAX_PER_RUN updates per run. Costs nothing: no model is used.
 */
import { readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { CheckResult, Exec, UpdateFound } from '@aip/checks';
import type { AppSettings } from './settings.ts';
import { checkCodeFolder, codeFolderOf, stamp, type Git } from './runs.ts';

export const MAX_PER_RUN = 3;
export const GITHUB_UNAVAILABLE = 'GitHub checks not available; local checks only';
export const OFF_TEXT = 'Dev-tool patch updates are off, so nothing was done. Turn them on in Settings if you want the app to prepare them.';

export type Section = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies';
const SECTIONS: Section[] = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

const STRICT = /^(\d+)\.(\d+)\.(\d+)$/;
const SPEC = /^([\^~]?)(\d+)\.(\d+)\.(\d+)$/;

export type Verdict = { ok: true; newSpec: string } | { ok: false; why: string };

/**
 * Is this ONE package's move a dev-tool patch update the app may prepare? Pure: no files, no network.
 * `sections` are the package.json sections the package is listed in. `spec` is its text there.
 */
export function classifyPatch(p: { name: string; sections: Section[]; spec: string; from: string; to: string }): Verdict {
  const no = (why: string): Verdict => ({ ok: false, why: `${p.name} ${p.from} → ${p.to}: ${why}` });
  if (!p.sections.includes('devDependencies')) return no('it isn’t a dev tool (devDependencies), so it’s left to you.');
  if (p.sections.length !== 1) return no('it’s listed in more than one place in package.json, so it’s left to you.');
  const from = STRICT.exec(p.from);
  const to = STRICT.exec(p.to);
  if (!from || !to) return no('a pre-release or unusual version number, so it’s left to you.');
  if (from[1] !== to[1]) return no('a major update, so it’s left to you.');
  if (from[2] !== to[2]) return no('a minor update, so it’s left to you.');
  if (Number(to[3]) <= Number(from[3])) return no('not a newer patch.');
  const spec = SPEC.exec(p.spec.trim());
  if (!spec) return no(`its version in package.json (“${p.spec}”) isn’t a plain version or ^/~ range the app can change safely, so it’s left to you.`);
  if (spec[2] !== to[1] || spec[3] !== to[2]) return no('package.json asks for a different major or minor than the one installed, so it’s left to you.');
  if (Number(spec[4]) > Number(to[3])) return no('package.json already asks for a newer patch.');
  return { ok: true, newSpec: `${spec[1]}${to[1]}.${to[2]}.${to[3]}` };
}

/** Where a package is listed in a parsed package.json. */
export function sectionsOf(pkg: Record<string, unknown>, name: string): { sections: Section[]; spec: string } {
  const sections: Section[] = [];
  let spec = '';
  for (const s of SECTIONS) {
    const block = pkg[s];
    if (block && typeof block === 'object' && !Array.isArray(block) && typeof (block as Record<string, unknown>)[name] === 'string') {
      sections.push(s);
      if (s === 'devDependencies' || !spec) spec = (block as Record<string, string>)[name]!;
    }
  }
  return { sections, spec };
}

/** The new package.json text: only that one devDependencies line changes, so formatting stays. Null if it can't be done exactly. */
export function editSpec(text: string, name: string, oldSpec: string, newSpec: string): string | null {
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`("${esc(name)}"\\s*:\\s*)"${esc(oldSpec)}"`, 'g');
  if ((text.match(re) ?? []).length !== 1) return null;
  const out = text.replace(re, `$1"${newSpec}"`);
  try {
    const parsed = JSON.parse(out) as { devDependencies?: Record<string, string> };
    return parsed.devDependencies?.[name] === newSpec ? out : null;
  } catch {
    return null;
  }
}

export type Outcome = 'waiting' | 'rolled back' | 'skipped';
export interface MaintenanceItem {
  package: string;
  from: string;
  to: string;
  outcome: Outcome;
  /** Plain words: why it waits, was rolled back or was left alone. */
  detail: string;
  /** The waiting (or recorded-as-failed) item's build number in the Build list; null when skipped. */
  runId: number | null;
}
export interface MaintenanceResult {
  ran: boolean;
  slug: string;
  summary: string;
  items: MaintenanceItem[];
  /** What GitHub's checks said, in plain words ('' when nothing was tried). */
  githubNote: string;
}

/** GitHub's check status for a branch, if it can be read. Null = not available. */
export type GithubStatus = (slug: string, branch: string) => Promise<'green' | 'red' | 'pending' | null>;

export interface MaintenanceOptions {
  now?: Date;
  git?: Git;
  /** Newer versions in a code folder; the real one is `pnpm outdated` (free; installs nothing). */
  find?: (dir: string) => Promise<UpdateFound[]>;
  /** Runs the package manager and the project's tests; the real one is @aip/checks. Swapped in tests. */
  exec?: Exec;
  freeChecks?: (dir: string, base: string, areas: string[]) => Promise<CheckResult[]>;
  /** GitHub's check status for the branch. Default: not available (the branch is never pushed). */
  githubStatus?: GithubStatus;
}

const FIFTEEN_MINUTES = 15 * 60_000;
const first = (m: string) => m.split('\n')[0]!.slice(0, 300);

/** Files a patch update may change in its worktree. Anything else means something went wrong. */
const ALLOWED_FILES: Record<string, string[]> = { pnpm: ['package.json', 'pnpm-lock.yaml'], npm: ['package.json', 'package-lock.json'] };

const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'pkg';

export const featureName = (u: { package: string; from: string; to: string }) => `Maintenance: ${u.package} ${u.from} → ${u.to}`;

async function withRuns<T>(dbPath: string, fn: (log: import('@aip/memory').RunLog) => T | Promise<T>): Promise<T> {
  const m = await import('@aip/memory');
  const log = m.RunLog.open(dbPath);
  try {
    return await fn(log);
  } finally {
    log.close();
  }
}

/** Removes the update's copy and branch. Never throws; says what it couldn't do. */
async function rollback(g: Git, folder: string, path: string, branch: string): Promise<string> {
  const left: string[] = [];
  try {
    await g(['worktree', 'remove', '--force', path], folder);
  } catch {
    try {
      await rm(path, { recursive: true, force: true });
      await g(['worktree', 'prune'], folder);
    } catch {
      left.push(`remove ${path} by hand`);
    }
  }
  try {
    await g(['branch', '-D', branch], folder);
  } catch {
    // the branch may never have been made
    try {
      await g(['rev-parse', '--verify', `refs/heads/${branch}`], folder);
      left.push(`branch ${branch} is still there`);
    } catch {
      // not there: fine
    }
  }
  return left.length ? ` Tidy-up left something: ${left.join('; ')}.` : '';
}

/** The package manager arguments: --ignore-scripts always (INSTALL_ARGS); pnpm must be allowed to change its lock file. */
export function installArgs(pm: 'pnpm' | 'yarn' | 'npm', ignoreScripts: readonly string[]): string[] {
  return [...ignoreScripts, ...(pm === 'pnpm' ? ['--no-frozen-lockfile'] : [])];
}

/**
 * One maintenance run for one project. Does nothing when the setting is off. Prepares at most
 * MAX_PER_RUN patch updates, one at a time, each in its own worktree. Never touches joshua's branch.
 */
export async function runMaintenance(settings: AppSettings, slug: string, dbPath: string, opts: MaintenanceOptions = {}): Promise<MaintenanceResult> {
  const result = (summary: string, items: MaintenanceItem[] = [], githubNote = '', ran = true): MaintenanceResult => ({ ran, slug, summary, items, githubNote });
  if (!settings.maintenance.patchUpdates) return result(OFF_TEXT, [], '', false);
  const now = opts.now ?? new Date();
  const m = await import('@aip/memory');
  const c = await import('@aip/checks');
  const g: Git = opts.git ?? m.realGit;
  const exec: Exec = opts.exec ?? c.realExec;
  const folder = codeFolderOf(settings, slug);
  const status = await checkCodeFolder(folder, g);

  // 1. What's out of date here, read-only.
  let found: UpdateFound[];
  try {
    found = await (opts.find ?? ((d: string) => c.findUpdates(d)))(folder);
  } catch (err) {
    return result(`Couldn’t look for updates in ${slug}: ${first((err as Error).message)} Nothing was changed.`);
  }
  let pkgText: string;
  let pkg: Record<string, unknown>;
  try {
    pkgText = await readFile(join(folder, 'package.json'), 'utf8');
    pkg = JSON.parse(pkgText) as Record<string, unknown>;
  } catch {
    return result(`${slug} has no readable package.json at the top of its code folder, so there’s nothing to update. Nothing was changed.`);
  }
  const pm = await c.packageManager(folder);
  const items: MaintenanceItem[] = [];
  const skip = (u: { package: string; from: string; to: string }, detail: string) => items.push({ ...u, outcome: 'skipped', detail, runId: null });

  const known = await withRuns(dbPath, (log) => log.list(slug, 500).filter((r) => r.model === m.MAINTENANCE_MODEL));
  const todo: { u: { package: string; from: string; to: string }; spec: string; newSpec: string }[] = [];
  for (const f of found) {
    const u = { package: f.package, from: f.current, to: f.latest };
    const { sections, spec } = sectionsOf(pkg, f.package);
    if (!sections.length) {
      skip(u, `${f.package} isn’t listed at the top of package.json (it may belong to a sub-package), so it’s left to you.`);
      continue;
    }
    const v = classifyPatch({ name: f.package, sections, spec, from: f.current, to: f.latest });
    if (!v.ok) {
      skip(u, v.why);
      continue;
    }
    if (known.some((r) => r.feature === featureName(u) && (r.status === 'built' || r.status === 'failed' || r.status === 'kept'))) {
      skip(u, 'already tried: it’s waiting for you in Build, or it failed before and is left alone until a newer version comes out.');
      continue;
    }
    if (known.some((r) => r.status === 'built' && r.feature.startsWith(`Maintenance: ${f.package} `))) {
      skip(u, `an earlier update of ${f.package} is still waiting in Build. Keep or Undo it first.`);
      continue;
    }
    todo.push({ u, spec, newSpec: v.newSpec });
  }

  if (pm === 'yarn') {
    for (const t of todo) skip(t.u, 'this project uses yarn, which the app doesn’t change by itself yet, so it’s left to you.');
    todo.length = 0;
  }

  // 2. One at a time, at most MAX_PER_RUN, each in its own copy.
  let githubNote = '';
  for (const t of todo.slice(0, MAX_PER_RUN)) {
    const feature = featureName(t.u);
    const tag = stamp(now);
    const branch = `aip/maint-${slugOf(t.u.package)}-${tag}`;
    const path = join(dirname(resolve(folder)), `${basename(resolve(folder))}-runs`, `maint-${slugOf(t.u.package)}-${tag}`);
    const started = Date.now();
    const base = (await g(['rev-parse', 'HEAD'], folder)).trim();
    const failed = async (why: string): Promise<void> => {
      const left = await rollback(g, folder, path, branch);
      const id = await withRuns(dbPath, (log) => {
        const rid = log.start({ at: now, slug, feature, path, branch, base, model: m.MAINTENANCE_MODEL });
        log.fail(rid, { status: 'failed', cause: 'tool', error: `${why}${left}`, costUsd: 0, ms: Date.now() - started, at: now });
        log.markCleaned(rid, now); // its copy is already gone: no Undo to offer
        return rid;
      });
      items.push({ ...t.u, outcome: 'rolled back', detail: `${why} Rolled back: nothing reached your branch.${left}`, runId: id });
    };
    try {
      await g(['worktree', 'add', '-b', branch, path, base], folder);
    } catch (err) {
      await failed(`Couldn’t make a separate copy: ${first((err as Error).message)}`);
      continue;
    }
    try {
      // The copy's package.json, one line changed.
      const wtText = await readFile(join(path, 'package.json'), 'utf8');
      const edited = editSpec(wtText, t.u.package, t.spec, t.newSpec);
      if (!edited) throw new Error(`Couldn’t change the version of ${t.u.package} in package.json safely.`);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(path, 'package.json'), edited, 'utf8');

      // Install without running any package's own scripts, then the project's tests.
      const install = await exec(pm, installArgs(pm, c.INSTALL_ARGS), path, FIFTEEN_MINUTES);
      if (install.code !== 0) throw new Error(`Installing failed: ${first(install.output.trim().split('\n').slice(-1)[0] ?? 'no output')}`);
      const tests = await c.runTests(path, exec);
      if (!tests.passed) throw new Error(`The tests failed with ${t.u.package} ${t.u.to}: ${first((tests.detail ?? '').trim().split('\n').slice(-1)[0] ?? '')}`);

      // Only the manifest and the lock file may have changed.
      const changed = (await g(['status', '--porcelain'], path)).split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, ''));
      const stray = changed.filter((f) => !ALLOWED_FILES[pm]!.includes(f));
      if (stray.length) throw new Error(`The update changed files it shouldn’t (${stray.slice(0, 3).join(', ')}${stray.length > 3 ? ', …' : ''}).`);
      if (!changed.includes('package.json')) throw new Error('The update changed nothing.');

      // Free checks (secrets, audit, new packages) on the copy.
      let checks: CheckResult[];
      try {
        checks = await (opts.freeChecks ?? ((d, b, a) => c.runFreeChecks(d, b, a, exec)))(path, base, []);
      } catch (err) {
        checks = [{ name: 'free checks', passed: false, free: true, detail: `Couldn’t run: ${first((err as Error).message)}` }];
      }
      const keep = c.canKeep([{ ...tests, name: 'tests' }, ...checks]);
      if (!keep.keep) throw new Error(`These checks didn’t pass: ${keep.blocking.join(', ')}.`);

      // GitHub's status for the branch, when it can be read.
      const gh = await (opts.githubStatus ? opts.githubStatus(slug, branch) : Promise.resolve(null)).catch(() => null);
      if (gh === 'red' || gh === 'pending') throw new Error(`GitHub’s checks for the branch are ${gh === 'red' ? 'failing' : 'not finished'}.`);
      const ghNote = gh === 'green' ? 'GitHub checks green' : GITHUB_UNAVAILABLE;
      githubNote = ghNote;

      // Green: commit on the copy's own branch and wait for joshua's Keep.
      const files = changed;
      await g(['add', '--', ...files], path);
      await g(['commit', '-q', '-m', `${feature} (dev tool, patch)`], path);
      const findings = c.toFindings(checks);
      const id = await withRuns(dbPath, (log) => {
        const rid = log.start({ at: now, slug, feature, path, branch, base, model: m.MAINTENANCE_MODEL });
        log.finish(rid, {
          costUsd: 0,
          testsPassed: true,
          fixAttempts: 0,
          summary: `${t.u.package} ${t.u.from} → ${t.u.to}: dev-tool patch update. Installed with --ignore-scripts. Tests and free checks passed here. ${ghNote}. Only ${files.join(' and ')} changed. Not merged: press Keep to apply it to your copy.`,
          findings,
          pictures: [],
          ms: Date.now() - started,
        });
        return rid;
      });
      items.push({ ...t.u, outcome: 'waiting', detail: `Tests and free checks passed. ${ghNote}. It waits in Build for your Keep.`, runId: id });
    } catch (err) {
      await failed(first((err as Error).message));
    }
  }

  const waiting = items.filter((i) => i.outcome === 'waiting').length;
  const back = items.filter((i) => i.outcome === 'rolled back').length;
  const left = todo.length - Math.min(todo.length, MAX_PER_RUN);
  const summary = [
    found.length === 0 ? `Everything in ${slug} is up to date.` : `${waiting} dev-tool patch update${waiting === 1 ? '' : 's'} ready for your Keep in Build, ${back} rolled back, ${items.filter((i) => i.outcome === 'skipped').length} left to you.`,
    left > 0 ? `${left} more patch update${left === 1 ? '' : 's'} will be tried next run (at most ${MAX_PER_RUN} per run).` : '',
    waiting > 0 ? 'Nothing was merged or pushed.' : 'Nothing reached your branch.',
    githubNote,
    `Your copy stayed on ${status.branch}. Cost: £0.00 ($0.00).`,
  ].filter(Boolean).join(' ');
  return result(summary, items, githubNote);
}

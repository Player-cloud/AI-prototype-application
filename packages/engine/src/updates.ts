/**
 * CI-6: update spotting, adopted only with joshua's OK. "Look for updates" is a free look-up of
 * newer versions of the app's own packages. Each one found is kept in the data repo until joshua
 * says OK or no. The app never installs an update: after an OK it shows the exact command for
 * joshua to run, and then the free tests check the new version (a pass clears its retest mark; a
 * test that does worse is flagged). Nothing about the gatekeeper changes.
 *
 * CI-8: once an update is installed, the next look-up runs that tool's free tests to check it
 * really worked, and every installed update shows the command that puts the old version back.
 * Running that command is still joshua's job; the next look-up notices and marks it rolled back.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UpdateFound } from '@aip/checks';
import type { UpdateCheck, UpdateRecord } from '@aip/memory';
import type { AppSettings } from './settings.ts';

export interface UpdateRow extends UpdateRecord {
  /** Plain words for the screen. */
  text: string;
  /** After an OK: what joshua runs in the app folder to adopt it. */
  command: string;
  /** CI-8: once installed, what puts the old version back ('' otherwise). */
  undoCommand: string;
}

export interface UpdatesReport { updates: UpdateRow[]; summary: string; synced: string }

const APP_DIR = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The app's source folder (the monorepo), or null in an installed app: there the engine sits in
 * <app>/engine and the app's own packages update with a new installer, not with `pnpm update`.
 */
export function sourceFolder(dir = APP_DIR): string | null {
  return existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(join(dir, 'packages', 'engine')) ? dir : null;
}

export const INSTALLED_TEXT = 'This is an installed copy of the app: its own packages update with a new installer, so “Look for updates” only works in the app’s source folder. Nothing was checked.';

/** The command that adopts one OK'd update, for joshua to run himself. */
export function adoptCommand(u: Pick<UpdateRecord, 'package' | 'to' | 'usedBy'>): string {
  const filters = u.usedBy.map((p) => `--filter ${p} `).join('');
  return `pnpm ${filters}update ${u.package}@${u.to}`;
}

/** CI-8: the command that puts an installed update's old version back, for joshua to run. */
export function rollbackCommand(u: Pick<UpdateRecord, 'package' | 'from' | 'usedBy'>): string {
  return adoptCommand({ package: u.package, to: u.from, usedBy: u.usedBy });
}

function installedText(c: UpdateCheck | null | undefined): string {
  if (!c) return 'Installed. It gets checked with its free tests on the next look for updates.';
  switch (c.outcome) {
    case 'passed':
      return `Installed and checked: ${c.detail}`;
    case 'worse':
      return `Installed, but it did worse: ${c.detail} To go back, run the command below, then pnpm install.`;
    case 'blocked':
      return `Installed, but its free tests couldn’t run here: ${c.detail}`;
    default:
      return `Installed. ${c.detail}`;
  }
}

export function updateText(u: UpdateRecord): string {
  const what = `${u.package} ${u.from} → ${u.to} (${u.level === 'major' ? 'major: may change how it works' : u.level})`;
  const used = u.usedBy.length ? `, used by ${u.usedBy.join(', ')}` : '';
  const dep = u.deprecated ? ' The version in use is marked deprecated.' : '';
  const state =
    u.status === 'found'
      ? 'Waiting for your OK. Nothing is installed until you run it yourself.'
      : u.status === 'approved'
        ? 'You said OK. Run the command below in the app folder, then pnpm install, then Run free tests.'
        : u.status === 'declined'
          ? 'You said no. It won’t be suggested again.'
          : u.status === 'rolled back'
            ? `Rolled back to ${u.from}. Say OK again if you want it later.`
            : installedText(u.check);
  return `${what}${used}.${dep} ${state}`;
}

const rows = (us: UpdateRecord[]): UpdateRow[] =>
  us.map((u) => ({ ...u, text: updateText(u), command: u.status === 'approved' || u.status === 'rolled back' ? adoptCommand(u) : '', undoCommand: u.status === 'installed' ? rollbackCommand(u) : '' }));

/** What the free tests said about one capability after an update. */
export type UpdateTester = (capability: string) => Promise<{ outcome: 'passed' | 'failed' | 'blocked'; detail: string; worse: string[] }>;

/** CI-8: checks one installed update with its tool's free tests. Never throws: a broken check says so. */
export async function checkInstalled(u: UpdateRecord, test: UpdateTester, now: Date): Promise<UpdateCheck> {
  const at = now.toISOString();
  const c = await import('@aip/checks');
  if (!u.capability || !c.SUITES.some((s) => s.free && s.capability === u.capability)) {
    return { at, outcome: 'not run', detail: 'No free test covers it: run pnpm check in the app folder to be sure it works.' };
  }
  try {
    const r = await test(u.capability);
    if (r.outcome === 'failed' || r.worse.length) return { at, outcome: 'worse', detail: [r.detail, ...r.worse].filter(Boolean).join(' ') };
    if (r.outcome === 'blocked') return { at, outcome: 'blocked', detail: r.detail };
    return { at, outcome: 'passed', detail: r.detail };
  } catch (err) {
    return { at, outcome: 'blocked', detail: `The check broke: ${(err as Error).message.split('\n')[0]}` };
  }
}

/** The default tester: the free repeatable tests (CI-3), which also save their results and health. */
function freeTester(settings: AppSettings, now: Date): UpdateTester {
  return async (capability) => {
    const { runFreeTests } = await import('./evals.ts');
    const r = await runFreeTests(settings, { capability, now });
    const failed = r.results.filter((x) => x.outcome === 'failed');
    const blocked = r.results.filter((x) => x.outcome === 'blocked');
    const outcome = failed.length ? 'failed' : blocked.length && blocked.length === r.results.length ? 'blocked' : 'passed';
    const detail = failed.length ? failed.map((x) => `${x.suite} failed: ${x.detail}`).join(' ') : blocked.length ? blocked.map((x) => x.detail).join(' ') : `its free tests pass (${r.results.length}).`;
    return { outcome, detail, worse: r.regressions ?? [] };
  };
}

async function save(settings: AppSettings, updates: UpdateRecord[], message: string): Promise<string> {
  const m = await import('@aip/memory');
  await m.writeUpdates(settings.dataFolder!, updates);
  try {
    return (await m.syncDataRepo(settings.dataFolder!, message)).summary;
  } catch (err) {
    return `Saved here, but not synced yet: ${(err as Error).message}`;
  }
}

/** Settings → Tools → Look for updates. Free; installs nothing. */
export async function checkUpdates(settings: AppSettings, opts: { now?: Date; find?: () => Promise<UpdateFound[]>; test?: UpdateTester; appDir?: string } = {}): Promise<UpdatesReport> {
  if (!settings.dataFolder) throw new Error('Set the data folder in Settings first: updates found are kept there.');
  const source = opts.find ? APP_DIR : sourceFolder(opts.appDir);
  if (!source) throw new Error(INSTALLED_TEXT);
  const c = await import('@aip/checks');
  const m = await import('@aip/memory');
  const now = opts.now ?? new Date();
  const found = await (opts.find ?? (() => c.findUpdates(source)))();
  const before = await m.readUpdates(settings.dataFolder);
  // A package no longer listed as out of date has reached at least the newest version on record.
  const installed: Record<string, string> = {};
  for (const u of before) installed[u.package] = found.find((f) => f.package === u.package)?.current ?? u.to;
  let updates = m.mergeUpdates(before, found, installed, now, c.computerId());
  // CI-8: check each newly installed update really worked, and note any rolled back.
  const test = opts.test ?? freeTester(settings, now);
  const notes: string[] = [];
  for (const u of updates.filter((x) => x.status === 'installed' && !x.check)) {
    const check = await checkInstalled(u, test, now);
    updates = m.checkedUpdate(updates, u.package, u.to, check);
    notes.push(check.outcome === 'worse' ? `${u.package} ${u.to} did worse: see Updates to go back.` : check.outcome === 'passed' ? `${u.package} ${u.to} checked: it works.` : `${u.package} ${u.to}: ${check.detail}`);
  }
  for (const u of updates) {
    if (u.status === 'rolled back' && before.find((b) => b.package === u.package && b.to === u.to)?.status === 'installed') notes.push(`${u.package} is back on ${u.from}.`);
  }
  const synced = await save(settings, updates, 'Look for updates');
  const fresh = updates.filter((u) => u.status === 'found').length;
  const tracked = found.filter((f) => f.capability).length;
  return {
    updates: rows(updates),
    summary: [
      `${found.length ? `${found.length} newer version${found.length === 1 ? '' : 's'} found (${tracked} of the app’s tracked tools), ${fresh} waiting for your OK.` : 'Everything is up to date.'} Nothing was installed.`,
      ...notes,
      'Cost: £0.00 ($0.00).',
    ].join(' '),
    synced,
  };
}

/** joshua's OK or no on one update. The app still installs nothing. */
export async function decideUpdateNow(settings: AppSettings, pkg: string, to: string, ok: boolean, now = new Date()): Promise<{ update: UpdateRow; summary: string; synced: string }> {
  if (!settings.dataFolder) throw new Error('Set the data folder in Settings first.');
  const m = await import('@aip/memory');
  const updates = m.decideUpdate(await m.readUpdates(settings.dataFolder), pkg, to, ok, now);
  const synced = await save(settings, updates, `${ok ? 'OK' : 'No'} to ${pkg} ${to}`);
  const row = rows(updates).find((u) => u.package === pkg && u.to === to)!;
  return {
    update: row,
    summary: ok ? `OK noted for ${pkg} ${to}. To adopt it, run: ${row.command}` : `Noted: no to ${pkg} ${to}.`,
    synced,
  };
}

/** The updates on record, for the Tools page. */
export async function listUpdates(settings: AppSettings): Promise<UpdateRow[]> {
  if (!settings.dataFolder) return [];
  return rows(await (await import('@aip/memory')).readUpdates(settings.dataFolder));
}

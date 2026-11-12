/**
 * CI-6: update spotting, adopted only with joshua's OK. "Look for updates" is a free look-up of
 * newer versions of the app's own packages. Each one found is kept in the data repo until joshua
 * says OK or no. The app never installs an update: after an OK it shows the exact command for
 * joshua to run, and then the free tests check the new version (a pass clears its retest mark; a
 * test that does worse is flagged). Nothing about the gatekeeper changes.
 */
import { fileURLToPath } from 'node:url';
import type { UpdateFound } from '@aip/checks';
import type { UpdateRecord } from '@aip/memory';
import type { AppSettings } from './settings.ts';

export interface UpdateRow extends UpdateRecord {
  /** Plain words for the screen. */
  text: string;
  /** After an OK: what joshua runs in the app folder to adopt it. */
  command: string;
}

export interface UpdatesReport { updates: UpdateRow[]; summary: string; synced: string }

const APP_DIR = fileURLToPath(new URL('../../../', import.meta.url));

/** The command that adopts one OK'd update, for joshua to run himself. */
export function adoptCommand(u: Pick<UpdateRecord, 'package' | 'to' | 'usedBy'>): string {
  const filters = u.usedBy.map((p) => `--filter ${p} `).join('');
  return `pnpm ${filters}update ${u.package}@${u.to}`;
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
          : 'Installed. Run free tests to check it.';
  return `${what}${used}.${dep} ${state}`;
}

const rows = (us: UpdateRecord[]): UpdateRow[] => us.map((u) => ({ ...u, text: updateText(u), command: u.status === 'approved' ? adoptCommand(u) : '' }));

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
export async function checkUpdates(settings: AppSettings, opts: { now?: Date; find?: () => Promise<UpdateFound[]> } = {}): Promise<UpdatesReport> {
  if (!settings.dataFolder) throw new Error('Set the data folder in Settings first: updates found are kept there.');
  const c = await import('@aip/checks');
  const m = await import('@aip/memory');
  const now = opts.now ?? new Date();
  const found = await (opts.find ?? (() => c.findUpdates(APP_DIR)))();
  const before = await m.readUpdates(settings.dataFolder);
  // A package no longer listed as out of date has reached at least the newest version on record.
  const installed: Record<string, string> = {};
  for (const u of before) installed[u.package] = found.find((f) => f.package === u.package)?.current ?? u.to;
  const updates = m.mergeUpdates(before, found, installed, now, c.computerId());
  const synced = await save(settings, updates, 'Look for updates');
  const fresh = updates.filter((u) => u.status === 'found').length;
  const tracked = found.filter((f) => f.capability).length;
  return {
    updates: rows(updates),
    summary: `${found.length ? `${found.length} newer version${found.length === 1 ? '' : 's'} found (${tracked} of the app’s tracked tools), ${fresh} waiting for your OK.` : 'Everything is up to date.'} Nothing was installed. Cost: £0.00 ($0.00).`,
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

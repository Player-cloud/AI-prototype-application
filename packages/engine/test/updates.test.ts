import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UpdateFound } from '@aip/checks';
import { decideUpdate, mergeUpdates } from '@aip/memory';
import { adoptCommand, checkUpdates, decideUpdateNow, INSTALLED_TEXT, rollbackCommand, sourceFolder, type UpdateTester } from '../src/updates.ts';
import { checkSettings } from '../src/settings.ts';
import { handleLine } from '../src/protocol.ts';

const NOW = new Date('2026-11-12T12:00:00Z');
const SECRETLINT: UpdateFound = { package: '@secretlint/node', current: '11.7.1', latest: '13.1.0', level: 'major', deprecated: false, usedBy: ['@aip/checks'], capability: 'secretlint' };
const VITE: UpdateFound = { package: 'vite', current: '8.3.7', latest: '8.3.8', level: 'patch', deprecated: false, usedBy: ['@aip/desktop'], capability: '' };

describe('update records (CI-6)', () => {
  it('keeps decisions, never duplicates, and marks an update installed when the version arrives', () => {
    let us = mergeUpdates([], [SECRETLINT, VITE], {}, NOW, 'lapto');
    expect(us.map((u) => [u.package, u.status])).toEqual([['@secretlint/node', 'found'], ['vite', 'found']]);
    us = decideUpdate(us, 'vite', '8.3.8', false, NOW);
    us = mergeUpdates(us, [SECRETLINT, VITE], { '@secretlint/node': '11.7.1', vite: '8.3.7' }, NOW, 'lapto');
    expect(us.map((u) => [u.package, u.status])).toEqual([['@secretlint/node', 'found'], ['vite', 'declined']]);
    us = decideUpdate(us, '@secretlint/node', '13.1.0', true, NOW);
    us = mergeUpdates(us, [VITE], { '@secretlint/node': '13.1.0', vite: '8.3.7' }, NOW, 'lapto');
    expect(us.find((u) => u.package === '@secretlint/node')?.status).toBe('installed');
    expect(() => decideUpdate(us, '@secretlint/node', '13.1.0', true, NOW)).toThrow('@secretlint/node 13.1.0 is already installed.');
    expect(() => decideUpdate(us, 'nope', '1.0.0', true, NOW)).toThrow('There’s no update of nope to 1.0.0 on record.');
  });

  it('gives the exact command to adopt an update, for joshua to run', () => {
    expect(adoptCommand({ package: '@secretlint/node', to: '13.1.0', usedBy: ['@aip/checks'] })).toBe('pnpm --filter @aip/checks update @secretlint/node@13.1.0');
  });
});

describe('look for updates, OK or no (CI-6)', () => {
  let data = '';
  beforeEach(async () => {
    data = await mkdtemp(join(tmpdir(), 'aip-updates-'));
    await writeFile(join(data, 'ledger.md'), '- secretlint | ON | secret scan | x\n');
  });
  afterEach(async () => {
    await rm(data, { recursive: true, force: true });
  });

  it('saves what was found, installs nothing, and an OK only shows the command', async () => {
    const settings = checkSettings({ dataFolder: data });
    const r = await checkUpdates(settings, { now: NOW, find: async () => [SECRETLINT, VITE] });
    expect(r.summary).toBe('2 newer versions found (1 of the app’s tracked tools), 2 waiting for your OK. Nothing was installed. Cost: £0.00 ($0.00).');
    expect(r.synced).toMatch(/^Saved here, but not synced yet/);
    expect(r.updates[0]!.text).toBe('@secretlint/node 11.7.1 → 13.1.0 (major: may change how it works), used by @aip/checks. Waiting for your OK. Nothing is installed until you run it yourself.');
    const saved = JSON.parse(await readFile(join(data, 'updates.json'), 'utf8'));
    expect(saved.updates).toHaveLength(2);

    const ok = await decideUpdateNow(settings, '@secretlint/node', '13.1.0', true, NOW);
    expect(ok.summary).toBe('OK noted for @secretlint/node 13.1.0. To adopt it, run: pnpm --filter @aip/checks update @secretlint/node@13.1.0');
    expect(ok.update).toMatchObject({ status: 'approved', command: 'pnpm --filter @aip/checks update @secretlint/node@13.1.0' });
    const no = await decideUpdateNow(settings, 'vite', '8.3.8', false, NOW);
    expect(no.summary).toBe('Noted: no to vite 8.3.8.');

    const o = JSON.parse((await handleLine(JSON.stringify({ id: 1, method: 'data_overview', params: { settings: { dataFolder: data } } })))!).result;
    expect(o.updates.map((u: { package: string; status: string }) => [u.package, u.status])).toEqual([['@secretlint/node', 'approved'], ['vite', 'declined']]);
    expect((await handleLine(JSON.stringify({ id: 2, method: 'update_decide', params: { settings: { dataFolder: data }, package: 'vite', to: '8.3.8' } })))).toContain('Say OK or no.');
  });

  it('says so when everything is up to date, and needs a data folder', async () => {
    expect((await checkUpdates(checkSettings({ dataFolder: data }), { find: async () => [] })).summary).toBe('Everything is up to date. Nothing was installed. Cost: £0.00 ($0.00).');
    await expect(checkUpdates(checkSettings({}), { find: async () => [] })).rejects.toThrow(/^Set the data folder in Settings first/);
  });

  it('in an installed app (no source folder) says updates come with a new installer, and checks nothing', async () => {
    const installed = await mkdtemp(join(tmpdir(), 'aip-installed-'));
    try {
      expect(sourceFolder(installed)).toBeNull();
      await expect(checkUpdates(checkSettings({ dataFolder: data }), { appDir: installed })).rejects.toThrow(INSTALLED_TEXT);
      expect(await readFile(join(data, 'updates.json'), 'utf8').catch(() => 'none')).toBe('none');
    } finally {
      await rm(installed, { recursive: true, force: true });
    }
  });

  it('finds the source folder when the app runs from it', () => {
    expect(sourceFolder()).not.toBeNull();
  });

  it('checks an installed update really worked, and gives the way back (CI-8)', async () => {
    const settings = checkSettings({ dataFolder: data });
    await checkUpdates(settings, { now: NOW, find: async () => [SECRETLINT, VITE] });
    await decideUpdateNow(settings, '@secretlint/node', '13.1.0', true, NOW);
    await decideUpdateNow(settings, 'vite', '8.3.8', true, NOW);
    const tested: string[] = [];
    const worse: UpdateTester = async (capability) => {
      tested.push(capability);
      return { outcome: 'failed', detail: 'secretlint-planted failed: Missed the private key.', worse: [] };
    };
    // joshua ran both commands: neither is out of date any more.
    const r = await checkUpdates(settings, { now: NOW, find: async () => [], test: worse });
    expect(tested).toEqual(['secretlint']);
    const sl = r.updates.find((u) => u.package === '@secretlint/node')!;
    expect(sl.status).toBe('installed');
    expect(sl.check).toMatchObject({ outcome: 'worse' });
    expect(sl.text).toContain('Installed, but it did worse: secretlint-planted failed: Missed the private key. To go back, run the command below, then pnpm install.');
    expect(sl.undoCommand).toBe('pnpm --filter @aip/checks update @secretlint/node@11.7.1');
    expect(sl.command).toBe('');
    const vite = r.updates.find((u) => u.package === 'vite')!;
    expect(vite.check).toMatchObject({ outcome: 'not run' });
    expect(vite.text).toContain('No free test covers it: run pnpm check');
    expect(r.summary).toContain('@secretlint/node 13.1.0 did worse: see Updates to go back.');

    // Checked once: the next look-up doesn't test it again.
    await checkUpdates(settings, { now: NOW, find: async () => [], test: worse });
    expect(tested).toEqual(['secretlint']);

    // joshua ran the way-back command: the next look-up sees the old version and marks it.
    const back = await checkUpdates(settings, { now: NOW, find: async () => [SECRETLINT], test: worse });
    const rolled = back.updates.find((u) => u.package === '@secretlint/node')!;
    expect(rolled.status).toBe('rolled back');
    expect(rolled.text).toContain('Rolled back to 11.7.1. Say OK again if you want it later.');
    expect(rolled.undoCommand).toBe('');
    expect(back.summary).toContain('@secretlint/node is back on 11.7.1.');
    const again = await decideUpdateNow(settings, '@secretlint/node', '13.1.0', true, NOW);
    expect(again.update.status).toBe('approved');
  });

  it('says plainly when the new version passes, or when its tests can’t run here', async () => {
    const settings = checkSettings({ dataFolder: data });
    await checkUpdates(settings, { now: NOW, find: async () => [SECRETLINT] });
    await decideUpdateNow(settings, '@secretlint/node', '13.1.0', true, NOW);
    const ok = await checkUpdates(settings, { now: NOW, find: async () => [], test: async () => ({ outcome: 'passed', detail: 'its free tests pass (1).', worse: [] }) });
    expect(ok.updates[0]!.text).toContain('Installed and checked: its free tests pass (1).');
    expect(ok.summary).toContain('@secretlint/node 13.1.0 checked: it works.');
  });

  it('a broken check is never counted as a pass', async () => {
    const settings = checkSettings({ dataFolder: data });
    await checkUpdates(settings, { now: NOW, find: async () => [SECRETLINT] });
    await decideUpdateNow(settings, '@secretlint/node', '13.1.0', true, NOW);
    const r = await checkUpdates(settings, { now: NOW, find: async () => [], test: async () => { throw new Error('no browser'); } });
    expect(r.updates[0]!.check).toMatchObject({ outcome: 'blocked', detail: 'The check broke: no browser' });
  });

  it('gives the command back to the old version', () => {
    expect(rollbackCommand({ package: 'vite', from: '8.3.7', usedBy: ['@aip/desktop'] })).toBe('pnpm --filter @aip/desktop update vite@8.3.7');
  });
});

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { noteToolVersion, recordToolRun } from '../src/data.ts';
import { checkSettings } from '../src/settings.ts';
import { handleLine } from '../src/protocol.ts';

let folder = '';

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'aip-engine-data-'));
  await mkdir(join(folder, 'tools'));
  await writeFile(join(folder, 'ledger.md'), '# Ledger\n\n- Only CLI (oc) | ON | web reading | fewer tokens | free | rating: -\n- EGM | TRIAL NEXT | planning | - | - | rating: -\n');
  await writeFile(join(folder, 'habits.md'), '- Plain words.\n');
  await writeFile(join(folder, 'rules.md'), '- One tool per job.\n- Ask first.\n');
  await writeFile(join(folder, 'tools', 'only-cli.md'), '# Only CLI (oc)\nWhat: page to outline.\nUse when: reading docs.\n');
});

afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

const overview = async (settings: Record<string, unknown>) =>
  JSON.parse(await handleLine(JSON.stringify({ id: 1, method: 'data_overview', params: { settings } })));

describe('data_overview', () => {
  it('says when no data folder is set', async () => {
    expect((await overview({})).result).toEqual({ configured: false });
  });

  it('lists the tools with their cards, habits and the first-read size', async () => {
    const r = (await overview({ dataFolder: folder })).result;
    expect(r.configured).toBe(true);
    expect(r.tools.map((t: { name: string; state: string }) => [t.name, t.state])).toEqual([
      ['Only CLI (oc)', 'on'],
      ['EGM', 'trial'],
    ]);
    expect(r.tools[0].what).toBe('page to outline.');
    expect(r.habits).toEqual(['Plain words.']);
    expect(r.ruleCount).toBe(2);
    expect(r.firstReadTokens).toBeGreaterThan(0);
    expect(r.firstReadTokens).toBeLessThan(r.allTokens);
  });

  it('shows each tool’s health from tool-health/', async () => {
    const settings = checkSettings({ dataFolder: folder });
    expect((await overview(settings)).result.tools[0]).toMatchObject({ health: '', stale: false, failuresInRow: 0, switchedOff: false });
    await noteToolVersion(settings, 'Only CLI (oc)', '1.2.0');
    await noteToolVersion(settings, 'Only CLI (oc)', '1.3.0');
    await recordToolRun(settings, 'Only CLI (oc)', { ok: false, error: 'timed out' }, new Date('2026-11-11T16:00:00Z'));
    const t = (await overview(settings)).result.tools[0];
    expect(t).toMatchObject({ stale: true, failuresInRow: 1, switchedOff: false });
    expect(t.health).toBe('Updated to 1.3.0 since it was tested. It gets a quick retest next time it’s used. 1 failure in a row.');
    // A good run (the retest) clears both.
    await recordToolRun(settings, 'Only CLI (oc)', { ok: true }, new Date('2026-11-11T16:05:00Z'));
    expect((await overview(settings)).result.tools[0]).toMatchObject({ health: '', stale: false, failuresInRow: 0 });
    await expect(recordToolRun(checkSettings({}), 'x', { ok: true }, new Date())).rejects.toThrow('Set your data folder in Settings first.');
  });

  it('explains a wrong folder in plain words', async () => {
    expect((await overview({ dataFolder: join(folder, 'tools') })).error).toContain('No ledger.md in');
  });
});

describe('tool_rate and data_sync', () => {
  const call = async (method: string, params: Record<string, unknown>) =>
    JSON.parse(await handleLine(JSON.stringify({ id: 2, method, params })));

  it('need a data folder', async () => {
    expect((await call('data_sync', { settings: {} })).error).toBe('Set your data folder in Settings first.');
    expect((await call('tool_rate', { settings: {}, tool: 'EGM', rating: 3 })).error).toBe('Set your data folder in Settings first.');
  });

  it('check the rating before touching anything', async () => {
    expect((await call('tool_rate', { settings: { dataFolder: folder }, tool: 'EGM', rating: '3' })).error).toBe(
      'Rating must be a whole number from 1 to 5',
    );
    expect((await call('tool_rate', { settings: { dataFolder: folder }, tool: 'EGM', rating: 9 })).error).toBe(
      'Rating must be a whole number from 1 to 5',
    );
  });

  it('refuse to sync a folder that is not a git clone', async () => {
    // The rating is saved locally first; the sync then explains why it can't push.
    expect((await call('tool_rate', { settings: { dataFolder: folder }, tool: 'EGM', rating: 3 })).error).toContain('is not a git clone');
  });
});

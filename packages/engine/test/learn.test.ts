import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunLog } from '@aip/memory';
import { guidance } from '../src/learn.ts';
import { handleLine } from '../src/protocol.ts';
import { checkSettings } from '../src/settings.ts';

const NOW = new Date('2026-11-11T19:30:00Z');

describe('the app learns habits after Keep, Undo and ratings', () => {
  let root = '';
  let db = '';
  let data = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aip-learn-'));
    db = join(root, 'history.sqlite');
    data = join(root, 'data'); // not a git clone, so syncing fails and says so
    await (await import('node:fs/promises')).mkdir(data);
    await writeFile(join(data, 'habits.md'), '# Habits\n\n- Plain words.\n');
    await writeFile(join(data, 'rules.md'), '- Ask first.\n');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function decided(n: number) {
    const log = RunLog.open(db);
    let id = 0;
    for (let i = 0; i < n; i++) {
      id = log.add({ at: NOW, slug: 'club-hr', feature: `F-0${i}`, path: '/x', branch: `b${i}`, base: 'abc', model: 'claude-sonnet-5-5', costUsd: 0.4, testsPassed: true, fixAttempts: 0, summary: '' });
      log.decide(id, 'kept', NOW);
    }
    log.close();
    return id;
  }

  const deps = { now: () => NOW, modelName: async () => 'Sonnet' } as never;
  const call = async (method: string, params: Record<string, unknown>) => JSON.parse(await handleLine(JSON.stringify({ id: 1, method, params }), deps));

  it('learns nothing without enough evidence', async () => {
    const id = decided(4);
    const r = (await call('run_rate', { settings: { dataFolder: data }, dbPath: db, id, rating: 5 })).result;
    expect(r.run.rating).toBe(5);
    expect(r.learned).toEqual([]);
    expect(await readFile(join(data, 'habits.md'), 'utf8')).toBe('# Habits\n\n- Plain words.\n');
  });

  it('writes a habit once there’s enough evidence, says so, and keeps it in the history', async () => {
    const id = decided(5);
    const r = (await call('run_rate', { settings: { dataFolder: data }, dbPath: db, id, rating: 5 })).result;
    expect(r.learned[0]).toBe('New habit: Sonnet builds are usually kept (kept 5 of 5): keep using it for builds.');
    expect(r.learned[1]).toMatch(/^Saved here, but not synced yet: /);
    const md = await readFile(join(data, 'habits.md'), 'utf8');
    expect(md).toContain('- Plain words.\n');
    expect(md).toContain('<!-- learned:model-good-claude-sonnet-5-5 -->');
    const history = (await call('history_list', { dbPath: db })).result;
    expect(history[0].label).toBe('Learned habits: 1 new');

    // Nothing new the second time.
    expect((await call('run_rate', { settings: { dataFolder: data }, dbPath: db, id, rating: 4 })).result.learned).toEqual([]);
  });

  it('gives the build model the rules and habits, rules first while the budget allows', async () => {
    const s = checkSettings({ dataFolder: data });
    const first = await guidance(s, true);
    expect(first).toContain('joshua’s rules come first');
    expect(first).toContain('Rules:\n- Ask first.');
    expect(first).toContain('Habits:\n- Plain words.');
    expect(await guidance(s, false)).toContain('Under 30% of this month’s budget is left');
    expect(await guidance(checkSettings({}), true)).toBe('');
  });
});

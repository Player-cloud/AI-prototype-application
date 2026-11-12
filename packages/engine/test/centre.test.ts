import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunLog } from '@aip/memory';
import { lifecycleOf } from '../src/centre.ts';
import { handleLine } from '../src/protocol.ts';

const call = async (method: string, params: Record<string, unknown>) => JSON.parse((await handleLine(JSON.stringify({ id: 1, method, params })))!);

let dir = '';
let data = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aip-centre-'));
  data = join(dir, 'data');
  await mkdir(join(data, 'tool-health'), { recursive: true });
  await writeFile(
    join(data, 'ledger.md'),
    ['- secretlint | ON | secret scan | caught planted keys', '- axe-core | ON | accessibility | -', '- shiny-tool | NOT TESTED | - | -', '- old-linter | OFF — replaced | lint | -', '- EGM | TRIAL NEXT | planning | -', ''].join('\n'),
  );
  await writeFile(join(data, 'tool-health', 'axe-core.json'), JSON.stringify({ tool: 'axe-core', id: 'axe-core', version: '4.12.0', testedVersion: '4.11.0', stale: true, retestDue: true }));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('Capability Centre (UI-01)', () => {
  it('names each lifecycle state from the records', () => {
    const base = { state: 'on' as const, stale: false, switchedOff: false, status: 'ON' };
    expect(lifecycleOf(base).lifecycle).toBe('in use');
    expect(lifecycleOf({ ...base, stale: true }).lifecycle).toBe('stale');
    expect(lifecycleOf({ ...base, switchedOff: true }).lifecycle).toBe('switched off');
    expect(lifecycleOf({ ...base, state: 'off', status: 'OFF' }).lifecycle).toBe('retired');
    expect(lifecycleOf({ ...base, state: 'trial' }).lifecycle).toBe('on trial');
    expect(lifecycleOf({ ...base, state: 'untested' }).lifecycle).toBe('not tested');
  });

  it('shows only what the records back: "Not tested" and "No builds yet", never 0', async () => {
    const r = (await call('capability_centre', { settings: { dataFolder: data } })).result;
    expect(r.configured).toBe(true);
    const row = (id: string) => r.rows.find((x: { id: string }) => x.id === id);
    expect(row('secretlint')).toMatchObject({ lifecycle: 'in use', tests: 'Not tested yet: it has a free test in Tools.', rating: 'Not rated', builds: '' });
    expect(row('axe-core')).toMatchObject({ lifecycle: 'stale', version: '4.12.0' });
    expect(row('shiny-tool')).toMatchObject({ lifecycle: 'not tested', tests: 'Not tested: no free test for it yet.' });
    expect(row('old-linter')).toMatchObject({ lifecycle: 'retired', why: 'Ledger: OFF — replaced' });
    expect(row('egm').lifecycle).toBe('on trial');
    expect(r.counts).toEqual({ 'in use': 1, stale: 1, 'on trial': 1, 'not tested': 1, 'switched off': 0, retired: 1 });
    expect(r.comparisons).toEqual(['Build history isn’t available here.']);
    expect(r.recommendations).toContain('axe-core changed since it was tested. Run its free test in Tools.');
    expect(r.recommendations).toContain('secretlint has a free test but no results yet. Run it in Tools (free).');
  });

  it('adds real builds to the build model, and says when there are too few to compare', async () => {
    const dbPath = join(dir, 'history.sqlite');
    const log = RunLog.open(dbPath);
    const id = log.add({ at: new Date(), slug: 's', feature: 'F-01', path: 'p', branch: 'b', base: 'c', model: 'claude-sonnet-5-5', costUsd: 0.2, testsPassed: true, fixAttempts: 0, summary: '', ms: 90_000 });
    log.decide(id, 'kept', new Date());
    log.close();
    const r = (await call('capability_centre', { settings: { dataFolder: data }, dbPath })).result;
    const model = r.rows.find((x: { id: string }) => x.id === 'sonnet-5-5');
    expect(model).toMatchObject({ kind: 'model', lifecycle: 'in use', name: 'Sonnet 5.5' });
    expect(model.builds).toMatch(/^Sonnet 5\.5: 1 of 1 builds kept, .*A first look, not proof\.$/);
    expect(r.comparisons[1]).toBe('To compare ways of building fairly, each needs at least 3 kept or undone builds.');
  });

  it('says so when no data folder is set', async () => {
    expect((await call('capability_centre', { settings: {} })).result).toEqual({ configured: false });
  });
});

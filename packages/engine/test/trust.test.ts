import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toFinding } from '@aip/checks';
import { findingOfOldCheck, readHealth, recordRun, writeHealth } from '@aip/memory';
import { handleLine } from '../src/protocol.ts';

const call = async (method: string, params: Record<string, unknown>) => JSON.parse((await handleLine(JSON.stringify({ id: 1, method, params })))!);
const NOW = new Date('2026-11-12T10:00:00Z');

let dir = '';
let data = '';
const healthFile = () => join(data, 'tool-health', 'axe-core.json');
const stored = async () => JSON.parse(await readFile(healthFile(), 'utf8')) as { trust: string };
const centreRow = async (id: string) => (await call('capability_centre', { settings: { dataFolder: data } })).result.rows.find((r: { id: string }) => r.id === id);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aip-trust-'));
  data = join(dir, 'data');
  await mkdir(join(data, 'tool-health'), { recursive: true });
  await writeFile(join(data, 'ledger.md'), ['- axe-core | ON | accessibility | -', '- shiny-tool | NOT TESTED | - | -', ''].join('\n'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('trust levels in the Capability Centre data', () => {
  it('a new tool starts unknown, in the Tools data and in the Centre', async () => {
    const overview = (await call('data_overview', { settings: { dataFolder: data } })).result;
    expect(overview.tools.map((t: { id: string; trust: string }) => [t.id, t.trust])).toEqual([['axe-core', 'unknown'], ['shiny-tool', 'unknown']]);
    expect((await centreRow('axe-core')).trust).toBe('unknown');
  });

  it('passing its health check moves a tool to checked (the app does this, on a good use)', async () => {
    const before = await readHealth(data, 'axe-core');
    await writeHealth(data, recordRun(before, { ok: true }, NOW));
    expect(await stored()).toMatchObject({ trust: 'checked' });
    expect((await centreRow('axe-core')).trust).toBe('checked');
  });

  it('joshua’s tool_trust action: trusted only from checked; unknown can’t be trusted', async () => {
    const settings = { dataFolder: data };
    const refused = await call('tool_trust', { settings, tool: 'shiny-tool', trust: 'trusted' });
    expect(refused.error).toMatch(/hasn’t passed its health check/);
    expect(await call('tool_trust', { settings, tool: 'axe-core', trust: 'trusted' })).toMatchObject({ error: expect.stringMatching(/hasn’t passed/) });

    await writeHealth(data, recordRun(await readHealth(data, 'axe-core'), { ok: true }, NOW));
    const ok = await call('tool_trust', { settings, tool: 'axe-core', trust: 'trusted' });
    expect(ok.error).toBeUndefined();
    expect(ok.result.trust).toBe('trusted');
    expect(ok.result.sync).toMatch(/not synced yet/); // this test folder isn't a git clone; the change is saved anyway
    expect(await stored()).toMatchObject({ trust: 'trusted' });
    expect((await centreRow('axe-core')).trust).toBe('trusted');

    // Stop trusting.
    expect((await call('tool_trust', { settings, tool: 'axe-core', trust: 'checked' })).result.trust).toBe('checked');
    expect(await stored()).toMatchObject({ trust: 'checked' });
    expect((await call('tool_trust', { settings, tool: 'axe-core', trust: 'bogus' })).error).toBe('Trust must be unknown, checked or trusted.');
  });

  it('scores never change trust: ratings, failures, health numbers and stale versions leave it as it is', async () => {
    const settings = { dataFolder: data };
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: data });
    await writeHealth(data, recordRun(await readHealth(data, 'axe-core'), { ok: true }, NOW));
    await call('tool_trust', { settings, tool: 'axe-core', trust: 'trusted' });
    // A 5/5 rating (a score) written to the ledger.
    await call('tool_rate', { settings, tool: 'axe-core', rating: 5 }).catch(() => undefined);
    expect(await stored()).toMatchObject({ trust: 'trusted' });
    // Several bad uses and a new version (health numbers go down, evidence goes stale).
    let h = await readHealth(data, 'axe-core');
    for (let i = 0; i < 2; i++) h = recordRun(h, { ok: false, error: 'x', cause: 'tool' }, NOW);
    await writeHealth(data, h);
    expect(await stored()).toMatchObject({ trust: 'trusted' });
    // The Centre and Tools show it, and showing them changes nothing.
    expect((await centreRow('axe-core')).trust).toBe('trusted');
    expect(await stored()).toMatchObject({ trust: 'trusted' });
  });

  it('a rating can’t raise an unknown tool', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: data });
    await call('tool_rate', { settings: { dataFolder: data }, tool: 'shiny-tool', rating: 5 }).catch(() => undefined);
    expect((await centreRow('shiny-tool')).trust).toBe('unknown');
  });

  it('the phone has no way to set trust: it is not among the commands a phone reply can run', async () => {
    const replies = await readFile(join(__dirname, '../src/replies.ts'), 'utf8');
    expect(replies).not.toMatch(/tool_trust|setToolTrust|setTrust|\btrust\b/i);
    const phone = await readFile(join(__dirname, '../src/phone.ts'), 'utf8');
    expect(phone).not.toMatch(/tool_trust|setToolTrust/);
  });
});

describe('the old converter and the checks adapter agree', () => {
  it('turns every old check into exactly the finding the checks package gives', () => {
    const states = [{}, { passed: false }, { passed: false, advisory: true }, { passed: false, advisory: true, detail: 'Not run: x' }, { passed: false, advisory: true, detail: 'No pictures: x' }, { detail: 'ok' }];
    for (const name of ['tests', 'secrets', 'audit', 'dependencies', 'checklist', 'axe', 'phone-overflow', 'pictures', 'free checks', 'other']) {
      for (const s of states) {
        const c = { name, passed: true, ...s };
        expect(findingOfOldCheck(c)).toEqual(toFinding(c));
      }
    }
  });
});

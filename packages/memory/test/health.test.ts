import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KEEP_FAILURES,
  emptyHealth,
  healthNote,
  listHealth,
  noteVersion,
  readHealth,
  recordRun,
  switchOff,
  switchOn,
  writeHealth,
} from '../src/index.js';

const T1 = new Date('2026-11-11T16:00:00Z');
const T2 = new Date('2026-11-11T16:05:00Z');

describe('tool health records', () => {
  it('takes the first version as the baseline, and a new one makes the evidence stale', () => {
    let h = noteVersion(emptyHealth('Only CLI (oc)'), '1.2.0');
    expect(h).toMatchObject({ version: '1.2.0', testedVersion: '1.2.0', stale: false, retestDue: false });
    expect(noteVersion(h, '1.2.0')).toBe(h);

    h = noteVersion(h, '1.3.0');
    expect(h).toMatchObject({ version: '1.3.0', testedVersion: '1.2.0', stale: true, retestDue: true });
    expect(healthNote(h)).toBe('Updated to 1.3.0 since it was tested. It gets a quick retest next time it’s used.');

    // Going back to the tested version needs no retest.
    expect(noteVersion(h, '1.2.0')).toMatchObject({ stale: false, retestDue: false });
  });

  it('a good retest clears the stale mark and the new version becomes the tested one', () => {
    let h = noteVersion(noteVersion(emptyHealth('oc'), '1.2.0'), '1.3.0');
    h = recordRun(h, { ok: false, error: 'timed out' }, T1);
    expect(h).toMatchObject({ stale: true, retestDue: true, consecutiveFailures: 1, lastRetest: { at: T1.toISOString(), ok: false } });
    h = recordRun(h, { ok: true }, T2);
    expect(h).toMatchObject({ stale: false, retestDue: false, testedVersion: '1.3.0', consecutiveFailures: 0, lastOk: T2.toISOString(), lastRetest: { ok: true } });
    expect(healthNote(h)).toBe('');
  });

  it('counts failures in a row, keeps the newest, and never keeps key-shaped text', () => {
    let h = emptyHealth('oc');
    for (let i = 0; i < KEEP_FAILURES + 5; i++) h = recordRun(h, { ok: false, error: `  error\n${i}  ` }, T1);
    expect(h.consecutiveFailures).toBe(KEEP_FAILURES + 5);
    expect(h.failures).toHaveLength(KEEP_FAILURES);
    expect(h.failures.at(-1)?.error).toBe(`error ${KEEP_FAILURES + 4}`);
    expect(healthNote(h)).toBe(`${KEEP_FAILURES + 5} failures in a row.`);

    // Obviously fake test value, not a real key.
    h = recordRun(h, { ok: false, error: 'bad key sk-ant-test-0000000000000000' }, T1);
    expect(h.failures.at(-1)?.error).toBe('Failed (the message looked like it held a key, so it wasn’t kept).');
    expect(recordRun(h, { ok: true }, T2).consecutiveFailures).toBe(0);
  });

  it('switching off keeps the tool; switching on resets the count and retests', () => {
    let h = recordRun(emptyHealth('oc'), { ok: false, error: 'x' }, T1);
    h = switchOff(h, '3 failures in a row.', T1);
    expect(healthNote(h)).toBe('Switched off: 3 failures in a row.');
    h = switchOn(h);
    expect(h).toMatchObject({ off: null, consecutiveFailures: 0, retestDue: true });
  });
});

describe('tool health files', () => {
  let folder = '';
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'aip-health-'));
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('saves one file per tool in tool-health/ and reads it back', async () => {
    expect(await readHealth(folder, 'Only CLI (oc)')).toEqual(emptyHealth('Only CLI (oc)'));
    const h = recordRun(noteVersion(emptyHealth('Only CLI (oc)'), '1.2.0'), { ok: true }, T1);
    expect(await writeHealth(folder, h)).toBe('tool-health/only-cli-oc.json');
    expect(JSON.parse(await readFile(join(folder, 'tool-health', 'only-cli-oc.json'), 'utf8'))).toEqual(h);
    expect(await readHealth(folder, 'Only CLI (oc)')).toEqual(h);
    expect([...(await listHealth(folder)).keys()]).toEqual(['only-cli-oc']);
  });

  it('keys each record by the tool’s stable ID when given one (CI-1)', async () => {
    const h = recordRun(emptyHealth('Haiku 5.5', 'haiku'), { ok: true }, T1);
    expect(h.id).toBe('haiku');
    expect(await writeHealth(folder, h)).toBe('tool-health/haiku.json');
    expect(await readHealth(folder, 'Claude Haiku 5.5', 'haiku')).toEqual({ ...h, tool: 'Claude Haiku 5.5' }); // named as the caller names it
    expect((await listHealth(folder)).get('haiku')).toMatchObject({ id: 'haiku', tool: 'Haiku 5.5' });
    await expect(writeHealth(folder, emptyHealth('x', '../oops'))).rejects.toThrow('can’t be used as a tool ID');
  });

  it('reads a damaged or odd file as a clean record instead of failing', async () => {
    await mkdir(join(folder, 'tool-health'), { recursive: true });
    await writeFile(join(folder, 'tool-health', 'oc.json'), '{oops');
    expect(await readHealth(folder, 'oc')).toEqual(emptyHealth('oc'));
    await writeFile(join(folder, 'tool-health', 'oc.json'), '{"consecutiveFailures": -3, "failures": [1, {"at": "x", "error": "y"}], "stale": "yes"}');
    expect(await readHealth(folder, 'oc')).toMatchObject({ consecutiveFailures: 0, failures: [{ at: 'x', error: 'y' }], stale: false });
    await expect(writeHealth(folder, emptyHealth('!!!'))).rejects.toThrow('can’t be used as a tool ID');
  });
});

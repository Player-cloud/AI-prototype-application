import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Environment, EnvOptions } from '@aip/checks';
import { environmentCheck, readEnvironments } from '../src/environment.ts';
import { checkSettings } from '../src/settings.ts';
import { handleLine } from '../src/protocol.ts';

const NOW = new Date('2026-11-12T10:30:00Z');

describe('compatibility per computer (CI-2)', () => {
  let data = '';
  beforeEach(async () => {
    data = await mkdtemp(join(tmpdir(), 'aip-env-'));
    await writeFile(join(data, 'ledger.md'), '- Only CLI | ON | web reading | x\n- Jina | ON | web reading | x\n');
  });
  afterEach(async () => {
    await rm(data, { recursive: true, force: true });
  });

  const fake = (computer: string, pnpm: string) => async (o: EnvOptions = {}): Promise<Environment> => ({
    computer,
    checkedAt: (o.now ?? NOW).toISOString(),
    os: 'Windows 10.0.26100',
    versions: { pnpm, ...o.extra },
    checks: [{ name: 'pnpm', ok: true, detail: `pnpm ${pnpm}.` }],
  });

  it('saves each computer’s check in the data repo and lists what differs between them', async () => {
    const settings = checkSettings({ dataFolder: data });
    const first = await environmentCheck(settings, NOW, { check: fake('joshu', '10.34.9') });
    expect(first.differences).toEqual([]);
    expect(first.synced).toMatch(/^Saved here, but not synced yet/); // not a git clone in this test
    const saved = JSON.parse(await readFile(join(data, 'environments', 'joshu.json'), 'utf8'));
    expect(saved).toMatchObject({ computer: 'joshu', versions: { pnpm: '10.34.9' } });
    // The Agent SDK's version comes along, read from the installed package.
    expect(saved.versions['claude-agent-sdk']).toMatch(/^\d+\.\d+\.\d+/);

    const second = await environmentCheck(settings, new Date('2026-11-12T11:00:00Z'), { check: fake('lapto', '10.20.0') });
    expect(second.differences).toEqual(['pnpm: joshu 10.34.9, lapto 10.20.0']);
    expect((await readEnvironments(data)).map((e) => e.computer)).toEqual(['lapto', 'joshu']); // newest first
  });

  it('shows computers, differences and clashing tools on the Tools page', async () => {
    await mkdir(join(data, 'environments'));
    await writeFile(join(data, 'environments', 'broken.json'), '{oops');
    const settings = { dataFolder: data };
    const r = JSON.parse(await handleLine(JSON.stringify({ id: 1, method: 'data_overview', params: { settings } }))).result;
    expect(r.environments).toEqual([]); // a damaged file is skipped
    expect(typeof r.computer).toBe('string');
    expect(r.clashes).toEqual(['Only CLI and Jina are both on for “web reading”. Keep one, or mark the other BACKUP.']);
    expect(r.tools[0]).toMatchObject({ id: 'only-cli', byComputer: '' });
  });

  it('works without a data folder, saving nothing', async () => {
    const r = await environmentCheck(checkSettings({}), NOW, { check: fake('joshu', '10.34.9') });
    expect(r).toMatchObject({ environment: { computer: 'joshu' }, differences: [], synced: '' });
  });
});

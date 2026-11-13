import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDataRepo, syncDataRepo } from '@aip/memory';
import { createDataFolder } from '../src/data-create.ts';
import { checkSettings } from '../src/settings.ts';
import { handleLine } from '../src/protocol.ts';

let root = '';
// Plain git with no global or system settings, like a fresh PC where nobody ran `git config`.
const env = () => ({ ...process.env, GIT_CONFIG_GLOBAL: join(root, 'no-global'), GIT_CONFIG_NOSYSTEM: '1' });
const git = async (args: string[], cwd: string) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: env() });
const named = checkSettings({ gitName: 'Sam Evaluator', gitEmail: 'sam@example.com' });

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'aip-newdata-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('a new data folder, with no terminal and no GitHub', () => {
  it('makes a starter data folder the app can read, committed with the name from Settings', async () => {
    const folder = join(root, 'My data');
    const r = await createDataFolder(named, folder, git);
    expect(r.summary).toContain('saved on this computer only');
    const repo = await loadDataRepo(folder);
    expect(repo.tools.length).toBeGreaterThan(10);
    expect(repo.rules.length).toBeGreaterThan(5);
    for (const f of ['ledger.md', 'rules.md', 'habits.md', 'README.md']) {
      expect(await readFile(join(folder, f), 'utf8')).not.toMatch(/joshua/i);
    }
    expect((await git(['log', '--format=%an <%ae> %s'], folder)).trim()).toBe('Sam Evaluator <sam@example.com> Start data folder');
    expect((await git(['remote'], folder)).trim()).toBe('');
  });

  it('then saves changes on this computer only (Local only)', async () => {
    const folder = join(root, 'data');
    await createDataFolder(named, folder, git);
    await writeFile(join(folder, 'habits.md'), '# Habits\n\n- Short replies.\n');
    // syncDataRepo uses the real git; the folder's own name and email are enough.
    const prev = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
    Object.assign(process.env, { GIT_CONFIG_GLOBAL: join(root, 'no-global'), GIT_CONFIG_NOSYSTEM: '1' });
    try {
      const s = await syncDataRepo(folder, 'Habit');
      expect(s).toEqual({ committed: true, pushed: false, summary: 'Saved 1 file. Kept on this computer only (GitHub sync is off).' });
    } finally {
      if (prev.g === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prev.g;
      if (prev.s === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = prev.s;
    }
  });

  it('asks for the name and email first, and changes nothing', async () => {
    const folder = join(root, 'x');
    await expect(createDataFolder(checkSettings({}), folder, git)).rejects.toThrow('Enter “Your name” and “Your email” in Settings');
    await expect(readFile(join(folder, 'ledger.md'), 'utf8')).rejects.toThrow();
  });

  it('never touches a folder that has something in it', async () => {
    const folder = join(root, 'busy');
    await mkdir(folder);
    await writeFile(join(folder, 'mine.txt'), 'keep me');
    await expect(createDataFolder(named, folder, git)).rejects.toThrow('isn’t empty, so nothing was changed');
    expect(await readFile(join(folder, 'mine.txt'), 'utf8')).toBe('keep me');
  });

  it('is an engine method that takes the name and email from the saved settings', async () => {
    const folder = join(root, 'via-engine');
    const reply = JSON.parse(await handleLine(JSON.stringify({ id: 1, method: 'data_create', params: { settings: { gitName: 'A', gitEmail: 'a@b.c' }, path: folder } })));
    expect(reply.result.folder).toBe(folder);
    expect(await readFile(join(folder, 'ledger.md'), 'utf8')).toContain('# Tool ledger');
  });
});

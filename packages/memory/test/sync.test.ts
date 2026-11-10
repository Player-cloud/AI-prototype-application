import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changedFiles, looksLikeKey, rateTool, setRating, syncDataRepo } from '../src/index.js';

const LEDGER = '# Ledger\n\n- Only CLI (oc) | ON | web reading | ok | free | rating: -\n- EGM | TRIAL NEXT | planning | - | -\n';

describe('ratings in the ledger', () => {
  it('sets a rating on the right line and leaves the rest alone', () => {
    const out = setRating(LEDGER, 'Only CLI (oc)', 4);
    expect(out).toContain('- Only CLI (oc) | ON | web reading | ok | free | rating: 4');
    expect(out).toContain('- EGM | TRIAL NEXT | planning | - | -');
    expect(setRating(LEDGER, 'EGM', 2)).toContain('- EGM | TRIAL NEXT | planning | - | - | rating: 2');
  });

  it('refuses bad ratings and unknown tools', () => {
    expect(() => setRating(LEDGER, 'EGM', 6)).toThrow('Rating must be a whole number from 1 to 5');
    expect(() => setRating(LEDGER, 'EGM', 2.5)).toThrow('Rating must be');
    expect(() => setRating(LEDGER, 'Nope', 3)).toThrow("Nope isn't in the ledger");
  });
});

describe('key check', () => {
  it('spots key shapes but not ordinary text', () => {
    expect(looksLikeKey('key: sk-ant-api03-abcdefghijklmnop')).toBe(true);
    expect(looksLikeKey('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(true);
    expect(looksLikeKey('Starts with sk- and is long')).toBe(false);
    expect(looksLikeKey('Haiku 5.5 | ON | reading')).toBe(false);
  });

  it('reads git’s list of changed files', () => {
    expect(changedFiles(' M ledger.md\n?? tools/new.md\nR  a.md -> b.md\n')).toEqual(['ledger.md', 'tools/new.md', 'b.md']);
  });
});

describe('sync with a real git repo', () => {
  let root = '';
  let clone = '';
  let other = '';
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aip-sync-'));
    const remote = join(root, 'remote.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    for (const name of ['clone', 'other']) {
      git(root, 'clone', '-q', remote, name);
      const dir = join(root, name);
      git(dir, 'config', 'user.email', 'test@example.com');
      git(dir, 'config', 'user.name', 'Test');
      git(dir, 'checkout', '-q', '-B', 'main');
    }
    clone = join(root, 'clone');
    other = join(root, 'other');
    await writeFile(join(clone, 'ledger.md'), LEDGER);
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', 'start');
    git(clone, 'push', '-q', '-u', 'origin', 'main');
    git(other, 'pull', '-q', 'origin', 'main');
    git(other, 'branch', '-q', '--set-upstream-to=origin/main');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('commits a rating and pushes it to GitHub', async () => {
    await rateTool(clone, 'EGM', 3);
    const r = await syncDataRepo(clone, 'Rate EGM 3/5');
    expect(r).toEqual({ committed: true, pushed: true, summary: 'Saved 1 file. Data repo is up to date on GitHub.' });
    git(other, 'pull', '-q');
    expect(await readFile(join(other, 'ledger.md'), 'utf8')).toContain('rating: 3');
  });

  it('brings in changes made on the other computer', async () => {
    await writeFile(join(other, 'habits.md'), '- New habit.\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'habit');
    git(other, 'push', '-q');
    await rateTool(clone, 'EGM', 5);
    await syncDataRepo(clone, 'Rate EGM 5/5');
    expect(await readFile(join(clone, 'habits.md'), 'utf8')).toBe('- New habit.\n');
  });

  it('stops without losing anything when both computers changed the same line', async () => {
    await writeFile(join(other, 'ledger.md'), setRating(LEDGER, 'EGM', 1));
    git(other, 'commit', '-q', '-am', 'other');
    git(other, 'push', '-q');
    await rateTool(clone, 'EGM', 4);
    await expect(syncDataRepo(clone, 'Rate EGM 4/5')).rejects.toThrow('clash');
    expect(await readFile(join(clone, 'ledger.md'), 'utf8')).toContain('rating: 4');
    expect(git(clone, 'status', '--porcelain')).toBe('');
  });

  it('refuses to push anything key-shaped', async () => {
    await writeFile(join(clone, 'notes.md'), 'oops sk-ant-api03-abcdefghijklmnopqrstu\n');
    await expect(syncDataRepo(clone, 'notes')).rejects.toThrow('notes.md has something that looks like a key');
    expect(git(clone, 'log', '--oneline')).not.toContain('notes');
  });

  it('explains a folder that is not a git clone', async () => {
    await expect(syncDataRepo(tmpdir(), 'x')).rejects.toThrow('is not a git clone');
  });
});

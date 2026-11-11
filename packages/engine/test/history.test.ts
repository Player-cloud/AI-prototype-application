import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleLine, realDeps } from '../src/protocol.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { describeSettingsChange, doneText, isInside, stable, undoLabel } from '../src/history.ts';

let dir = '';
let dbPath = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aip-history-'));
  dbPath = join(dir, 'history.sqlite');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-11-11T12:00:00Z');
const deps = { ...realDeps, now: () => NOW };

async function call(method: string, params: Record<string, unknown>) {
  return JSON.parse(await handleLine(JSON.stringify({ id: 1, method, params }), deps)) as { result?: any; error?: string };
}

describe('describing a settings change', () => {
  it('names each change in plain words', () => {
    const after = {
      ...DEFAULT_SETTINGS,
      provider: 'openai' as const,
      monthlyBudgetGbp: 30,
      dataFolder: 'C:\\data',
      extraRules: [{ match: 'stripe', reason: 'payments need my OK' }],
    };
    expect(describeSettingsChange(DEFAULT_SETTINGS, after)).toBe(
      'Provider Claude → OpenAI; Monthly budget £20 → £30; Data folder set to C:\\data; Added rule “stripe”',
    );
    expect(describeSettingsChange(after, DEFAULT_SETTINGS)).toContain('Removed rule “stripe”');
    expect(describeSettingsChange(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, codeFolders: { 'club-hr': '/code/club-hr' } })).toBe('Code folder for club-hr set to /code/club-hr');
    expect(describeSettingsChange({ ...DEFAULT_SETTINGS, codeFolders: { 'club-hr': '/code/club-hr' } }, DEFAULT_SETTINGS)).toBe('Code folder for club-hr cleared');
    expect(describeSettingsChange(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS })).toBe('');
  });

  it('gives the same text whatever order the keys come in', () => {
    expect(stable({ b: 1, a: { d: 2, c: [{ y: 1, x: 2 }] } })).toBe('{"a":{"c":[{"x":2,"y":1}],"d":2},"b":1}');
  });

  it('calls undoing an undo a redo', () => {
    expect(undoLabel('Rated EGM 4/5')).toBe('Undo: Rated EGM 4/5');
    expect(undoLabel('Undo: Rated EGM 4/5')).toBe('Redo: Rated EGM 4/5');
    expect(undoLabel('Redo: Rated EGM 4/5')).toBe('Undo: Rated EGM 4/5');
    expect(doneText('Rated EGM 4/5')).toBe('Undone: Rated EGM 4/5.');
    expect(doneText('Undo: Rated EGM 4/5')).toBe('Redone: Rated EGM 4/5.');
  });

  it('knows when a file is inside the data folder', () => {
    expect(isInside(dir, join(dir, 'ledger.md'))).toBe(true);
    expect(isInside(dir, join(dir, '..', 'other.md'))).toBe(false);
    expect(isInside('', join(dir, 'ledger.md'))).toBe(false);
  });
});

describe('settings history and undo', () => {
  it('keeps a settings change and puts it back on undo', async () => {
    const before = {};
    const after = { monthlyBudgetGbp: 30 };
    const saved = await call('settings_saved', { dbPath, before, after });
    expect(typeof saved.result).toBe('number');

    const list = (await call('history_list', { dbPath })).result;
    expect(list).toEqual([
      { id: saved.result, at: NOW.toISOString(), label: 'Monthly budget £20 → £30', kind: 'settings', undoneAt: null, isUndo: false },
    ]);

    const undo = await call('undo', { dbPath, id: saved.result, settings: after });
    expect(undo.result).toMatchObject({ kind: 'settings', label: 'Monthly budget £20 → £30', summary: 'Undone: Monthly budget £20 → £30.' });
    expect(undo.result.settings.monthlyBudgetGbp).toBe(20);

    // The shell saves the old settings, then records the undo.
    await call('settings_saved', { dbPath, before: after, after: undo.result.settings, undoes: { id: saved.result, label: undo.result.label } });
    const [newest, first] = (await call('history_list', { dbPath })).result;
    expect(newest).toMatchObject({ label: 'Undo: Monthly budget £20 → £30', isUndo: true, undoneAt: null });
    expect(first.undoneAt).toBe(NOW.toISOString());
    expect((await call('undo', { dbPath, id: first.id, settings: {} })).error).toBe('That change has already been undone.');
  });

  it('records nothing when nothing changed', async () => {
    expect((await call('settings_saved', { dbPath, before: {}, after: {} })).result).toBeNull();
    expect((await call('history_list', { dbPath })).result).toEqual([]);
  });

  it('refuses to undo when settings have changed since, and changes nothing', async () => {
    const id = (await call('settings_saved', { dbPath, before: {}, after: { monthlyBudgetGbp: 30 } })).result;
    const r = await call('undo', { dbPath, id, settings: { monthlyBudgetGbp: 40 } });
    expect(r.error).toMatch(/can’t be undone safely/);
    expect((await call('history_list', { dbPath })).result[0].undoneAt).toBeNull();
  });

  it('explains unknown changes and bad ids', async () => {
    expect((await call('undo', { dbPath, id: 42, settings: {} })).error).toBe('That change is no longer in the history.');
    expect((await call('undo', { dbPath, id: 'x', settings: {} })).error).toBe('id must be a whole number');
    expect((await call('settings_saved', { dbPath, before: {}, after: {}, undoes: { id: 'x' } })).error).toBe('undoes must have id and label');
  });
});

describe('rating history and undo', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });

  async function dataRepo() {
    const remote = join(dir, 'remote.git');
    const folder = join(dir, 'data');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { stdio: 'pipe' });
    execFileSync('git', ['clone', '-q', remote, folder], { stdio: 'pipe' });
    await writeFile(join(folder, 'ledger.md'), '# Ledger\n\n- EGM | TRIAL NEXT | planning | - | - | rating: -\n');
    git(folder, 'add', '-A');
    git(folder, 'commit', '-q', '-m', 'start');
    git(folder, 'push', '-q', '-u', 'origin', 'HEAD:main');
    git(folder, 'config', 'user.name', 'Test');
    git(folder, 'config', 'user.email', 'test@example.invalid');
    return { folder, remote };
  }

  it('undoes a rating, syncs the undo, and refuses if the ledger changed since', async () => {
    const { folder, remote } = await dataRepo();
    const settings = { dataFolder: folder };
    const ledger = join(folder, 'ledger.md');
    const original = await readFile(ledger, 'utf8');

    expect((await call('tool_rate', { settings, dbPath, tool: 'EGM', rating: 4 })).error).toBeUndefined();
    const [rated] = (await call('history_list', { dbPath })).result;
    expect(rated).toMatchObject({ label: 'Rated EGM 4/5', kind: 'file' });

    const undo = await call('undo', { dbPath, id: rated.id, settings });
    expect(undo.result.summary).toMatch(/^Undone: Rated EGM 4\/5\. .*up to date on GitHub/);
    expect(await readFile(ledger, 'utf8')).toBe(original);
    expect(execFileSync('git', ['log', '-1', '--format=%s', 'main'], { cwd: remote, encoding: 'utf8' }).trim()).toBe('Undo: Rated EGM 4/5');

    // Undo the undo, then change the ledger by hand: the older undo is now refused.
    const [undoRow] = (await call('history_list', { dbPath })).result;
    expect((await call('undo', { dbPath, id: undoRow.id, settings })).error).toBeUndefined();
    expect(await readFile(ledger, 'utf8')).toContain('rating: 4');
    const [redo] = (await call('history_list', { dbPath })).result;
    expect(redo.label).toBe('Redo: Rated EGM 4/5');
    await writeFile(ledger, `${await readFile(ledger, 'utf8')}- New | ON | x | - | - | rating: -\n`);
    expect((await call('undo', { dbPath, id: redo.id, settings })).error).toMatch(/This file can’t be undone safely/);
    expect(await readFile(ledger, 'utf8')).toContain('- New |');
  });

  it('still undoes locally when the sync fails, and says so', async () => {
    const { folder } = await dataRepo();
    const settings = { dataFolder: folder };
    await call('tool_rate', { settings, dbPath, tool: 'EGM', rating: 2 });
    const [rated] = (await call('history_list', { dbPath })).result;
    git(folder, 'remote', 'set-url', 'origin', join(dir, 'missing.git'));
    const undo = await call('undo', { dbPath, id: rated.id, settings });
    expect(undo.result.summary).toMatch(/^Undone: Rated EGM 2\/5\. Saved here, but not synced yet/);
    expect(await readFile(join(folder, 'ledger.md'), 'utf8')).toContain('rating: -');
  });
});

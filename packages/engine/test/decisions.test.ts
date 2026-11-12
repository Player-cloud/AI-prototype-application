import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_TEXT, PROMPT_CHARS, PROMPT_DECISIONS, decisionsHint, emptyDecisions, looksSecret, openBlockersFor, type DecisionsFile } from '../src/decisions.ts';
import { handleLine } from '../src/protocol.ts';

const NOW = new Date('2026-11-12T09:00:00Z');

describe('decisions and blockers', () => {
  let dir: string;
  let db: string;
  let settings: { dataFolder: string };
  const call = async (method: string, params: Record<string, unknown> = {}) =>
    JSON.parse(await handleLine(JSON.stringify({ id: 1, method, params: { settings, dbPath: db, ...params } }), { now: () => NOW } as never));
  const file = () => join(dir, 'projects', 'club-hr', 'decisions.json');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aip-dec-'));
    db = join(dir, 'history.sqlite');
    settings = { dataFolder: dir };
    await call('interview_start', { name: 'Club HR' });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts empty and saves a version 1 file with ids, dates and the optional fields', async () => {
    expect((await call('decisions_get', { slug: 'club-hr' })).result).toEqual({ version: 1, decisions: [], blockers: [] });
    const d1 = await call('decision_add', { slug: 'club-hr', text: '  Use   SQLite  ', why: 'No server to run', feature: 'F-01' });
    const d2 = await call('decision_add', { slug: 'club-hr', text: 'Dates are UK format' });
    expect(d1.result.decision).toEqual({ id: 'DEC-1', date: '2026-11-12', text: 'Use SQLite', why: 'No server to run', feature: 'F-01' });
    expect(d2.result.decision.id).toBe('DEC-2');
    expect(d2.result.decision).not.toHaveProperty('why');
    const b = await call('blocker_add', { slug: 'club-hr', text: 'Waiting for the logo', feature: 'F-02' });
    expect(b.result.blocker).toEqual({ id: 'BLK-1', date: '2026-11-12', text: 'Waiting for the logo', feature: 'F-02', open: true });
    const saved = JSON.parse(await readFile(file(), 'utf8')) as DecisionsFile;
    expect(saved.version).toBe(1);
    expect(saved.decisions.map((d) => d.id)).toEqual(['DEC-1', 'DEC-2']);
    expect((await call('decisions_get', { slug: 'club-hr' })).result).toEqual(saved);
  });

  it('is append-only: adding never changes earlier decisions, and there is no edit or delete', async () => {
    await call('decision_add', { slug: 'club-hr', text: 'First' });
    const before = JSON.parse(await readFile(file(), 'utf8')).decisions[0];
    await call('decision_add', { slug: 'club-hr', text: 'Second, replaces DEC-1' });
    expect((await call('decisions_get', { slug: 'club-hr' })).result.decisions[0]).toEqual(before);
    for (const m of ['decision_edit', 'decision_delete', 'decision_update', 'blocker_delete']) expect((await call(m, { slug: 'club-hr', id: 'DEC-1' })).error).toMatch(/unknown method/i);
  });

  it('caps the text, and the reason, a blocker and a note', async () => {
    const long = 'a '.repeat(MAX_TEXT);
    expect((await call('decision_add', { slug: 'club-hr', text: long })).error).toMatch(/too long/);
    expect((await call('decision_add', { slug: 'club-hr', text: 'ok', why: long })).error).toMatch(/too long/);
    expect((await call('blocker_add', { slug: 'club-hr', text: long })).error).toMatch(/too long/);
    expect((await call('decision_add', { slug: 'club-hr', text: 'x'.repeat(MAX_TEXT) })).error).toBeUndefined();
    expect((await call('decision_add', { slug: 'club-hr', text: '   ' })).error).toMatch(/Write what/);
    expect((await call('decision_add', { slug: 'club-hr', text: 'ok', feature: '../x' })).error).toMatch(/feature/);
    await call('blocker_add', { slug: 'club-hr', text: 'b' });
    expect((await call('blocker_close', { slug: 'club-hr', id: 'BLK-1', note: long })).error).toMatch(/too long/);
  });

  it('refuses text that looks like a key, and says why, and writes nothing', async () => {
    for (const bad of ['sk-ant-abcdefghijklmnop', 'token ghp_abcdefghijklmnopqrstuvwx', 'github_pat_abcdefghijklmnopqrstuvwxyz', 'sk-abcdefghijklmnopqrstuv', 'key is a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8']) {
      const r = await call('decision_add', { slug: 'club-hr', text: bad });
      expect(r.error, bad).toMatch(/looks like it has a key or password/);
      expect((await call('blocker_add', { slug: 'club-hr', text: bad })).error, bad).toMatch(/key or password/);
    }
    expect((await call('decision_add', { slug: 'club-hr', text: 'fine', why: 'sk-ant-abcdefghijklmnop' })).error).toMatch(/key or password/);
    await call('blocker_add', { slug: 'club-hr', text: 'b' });
    expect((await call('blocker_close', { slug: 'club-hr', id: 'BLK-1', note: 'ghp_abcdefghijklmnopqrstuvwx' })).error).toMatch(/key or password/);
    expect((await call('decisions_get', { slug: 'club-hr' })).result.decisions).toEqual([]);
    expect(looksSecret('Use the club-hr-members-table-for-everything please', () => false)).toBe(false);
  });

  it('closes a blocker with a note, once, and keeps it in the record', async () => {
    await call('blocker_add', { slug: 'club-hr', text: 'No logo' });
    const r = await call('blocker_close', { slug: 'club-hr', id: 'BLK-1', note: 'Logo arrived' });
    expect(r.result.blocker).toEqual({ id: 'BLK-1', date: '2026-11-12', text: 'No logo', open: false, closedAt: '2026-11-12', closedNote: 'Logo arrived' });
    expect((await call('blocker_close', { slug: 'club-hr', id: 'BLK-1' })).error).toMatch(/already closed/);
    expect((await call('blocker_close', { slug: 'club-hr', id: 'BLK-9' })).error).toMatch(/no blocker BLK-9/);
    expect((await call('decisions_get', { slug: 'club-hr' })).result.blockers).toHaveLength(1);
  });

  it('puts every change in the history with a plain label', async () => {
    await call('decision_add', { slug: 'club-hr', text: 'Use SQLite' });
    await call('blocker_add', { slug: 'club-hr', text: 'No logo' });
    await call('blocker_close', { slug: 'club-hr', id: 'BLK-1' });
    const labels = (await call('history_list', { dbPath: db })).result.map((h: { label: string }) => h.label).reverse();
    expect(labels.filter((l: string) => /club-hr/.test(l) && !/interview/i.test(l))).toEqual(['Decision DEC-1 for club-hr: Use SQLite', 'Blocker BLK-1 for club-hr: No logo', 'Closed blocker BLK-1 for club-hr']);
  });

  it('needs a data folder and an existing project', async () => {
    expect((await call('decisions_get', { slug: 'club-hr', settings: {} })).error).toBe('Set your data folder in Settings first.');
    expect((await call('decision_add', { slug: 'nope', text: 'x' })).error).toBeTruthy();
    expect((await call('decisions_get', { slug: '../x' })).error).toMatch(/valid project folder name/);
  });

  it('finds the open blockers for a feature: its own and the ones for the whole project', () => {
    const d: DecisionsFile = {
      ...emptyDecisions(),
      blockers: [
        { id: 'BLK-1', date: 'x', text: 'a', feature: 'F-01', open: true },
        { id: 'BLK-2', date: 'x', text: 'b', feature: 'F-02', open: true },
        { id: 'BLK-3', date: 'x', text: 'c', open: true },
        { id: 'BLK-4', date: 'x', text: 'd', feature: 'F-01', open: false },
      ],
    };
    expect(openBlockersFor(d, 'F-01').map((b) => b.id)).toEqual(['BLK-1', 'BLK-3']);
  });

  it('puts at most the newest 10 decisions in the prompt hint, each short', () => {
    const decisions = Array.from({ length: 14 }, (_, i) => ({ id: `DEC-${i + 1}`, date: 'x', text: i === 13 ? 'z'.repeat(400) : `Decision ${i + 1}` }));
    const lines = decisionsHint({ ...emptyDecisions(), decisions }).split('\n');
    expect(lines[1]).toBe('Decisions joshua made — follow them:');
    const shown = lines.slice(2);
    expect(shown).toHaveLength(PROMPT_DECISIONS);
    expect(shown[0]).toBe('- DEC-5: Decision 5');
    expect(shown.at(-1)!.length).toBeLessThanOrEqual(`- DEC-14: `.length + PROMPT_CHARS);
    expect(decisionsHint(emptyDecisions())).toBe('');
  });
});

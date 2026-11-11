import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChangeLog, KEEP_CHANGES, MAX_CHANGE_CHARS, SpendLog } from '../src/index.js';

const change = (label: string, extra: { undoes?: number; before?: string; after?: string } = {}) => ({
  at: new Date('2026-11-11T10:00:00Z'),
  kind: 'settings' as const,
  label,
  target: '',
  before: extra.before ?? '{"a":1}',
  after: extra.after ?? '{"a":2}',
  undoes: extra.undoes,
});

describe('change history', () => {
  it('records changes and lists them newest first', () => {
    const log = ChangeLog.open(':memory:');
    const first = log.record(change('first'));
    const second = log.record(change('second'));
    expect(log.list().map((c) => c.label)).toEqual(['second', 'first']);
    expect(log.get(first)).toMatchObject({ id: first, label: 'first', before: '{"a":1}', after: '{"a":2}', undoes: 0, undoneAt: null });
    expect(log.get(second)?.at).toBe('2026-11-11T10:00:00.000Z');
    expect(log.get(999)).toBeNull();
    log.close();
  });

  it('marks the earlier change undone when an undo is recorded', () => {
    const log = ChangeLog.open(':memory:');
    const id = log.record(change('budget'));
    const undo = log.record(change('Undo: budget', { undoes: id, before: '{"a":2}', after: '{"a":1}' }));
    expect(log.get(id)?.undoneAt).toBe('2026-11-11T10:00:00.000Z');
    expect(log.get(undo)).toMatchObject({ undoes: id, undoneAt: null });
    log.close();
  });

  it(`keeps only the newest ${KEEP_CHANGES} changes`, () => {
    const log = ChangeLog.open(':memory:');
    for (let i = 0; i < KEEP_CHANGES + 5; i++) log.record(change(`c${i}`));
    const all = log.list(KEEP_CHANGES + 10);
    expect(all).toHaveLength(KEEP_CHANGES);
    expect(all.at(-1)?.label).toBe('c5');
    log.close();
  });

  it('refuses changes too big to keep, and saves nothing', () => {
    const log = ChangeLog.open(':memory:');
    expect(() => log.record(change('huge', { after: 'x'.repeat(MAX_CHANGE_CHARS + 1) }))).toThrow(/too big/);
    expect(log.list()).toEqual([]);
    log.close();
  });

  it('shares the history file with the spend records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aip-history-'));
    try {
      const path = join(dir, 'sub', 'history.sqlite');
      const spend = SpendLog.open(path);
      spend.record({ at: new Date(), provider: 'claude', model: 'm', job: 'read', inputTokens: 1, outputTokens: 1, costUsd: 0.01 });
      spend.close();
      const log = ChangeLog.open(path);
      log.record(change('kept'));
      log.close();
      const again = ChangeLog.open(path);
      expect(again.list().map((c) => c.label)).toEqual(['kept']);
      again.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

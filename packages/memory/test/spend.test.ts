import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SpendLog, monthKey } from '../src/index.js';

const call = (at: string, costUsd: number | null) => ({
  at: new Date(at),
  provider: 'claude',
  model: 'claude-haiku-5-5',
  job: 'read',
  inputTokens: 10,
  outputTokens: 2,
  costUsd,
});

describe('spend log', () => {
  it('adds up this month and counts calls with no known price', () => {
    const log = SpendLog.open(':memory:');
    log.record(call('2026-11-03T10:00:00', 0.5));
    log.record(call('2026-11-20T10:00:00', 0.25));
    log.record(call('2026-11-21T10:00:00', null));
    log.record(call('2026-10-30T10:00:00', 9));
    expect(log.month('2026-11')).toEqual({ month: '2026-11', usd: 0.75, calls: 3, unknownCalls: 1 });
    expect(log.month('2026-12')).toEqual({ month: '2026-12', usd: 0, calls: 0, unknownCalls: 0 });
    log.close();
  });

  it('keeps records in a file across openings and makes the folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aip-spend-'));
    const path = join(dir, 'nested', 'history.sqlite');
    const a = SpendLog.open(path);
    a.record(call('2026-11-05T09:00:00', 1));
    a.close();
    const b = SpendLog.open(path);
    expect(b.month('2026-11').usd).toBe(1);
    b.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('uses the local calendar month', () => {
    expect(monthKey(new Date(2026, 0, 31, 23, 59))).toBe('2026-01');
    expect(monthKey(new Date(2026, 10, 1, 0, 0))).toBe('2026-11');
  });
  it('links each call to its build, and adds the column to a spend file made before run records', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const dir = await mkdtemp(join(tmpdir(), 'aip-spend-'));
    try {
      const path = join(dir, 'history.sqlite');
      const old = new DatabaseSync(path);
      old.exec('CREATE TABLE spend (id INTEGER PRIMARY KEY, at TEXT NOT NULL, month TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, job TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost_usd REAL)');
      old.exec("INSERT INTO spend (at, month, provider, model, job, input_tokens, output_tokens, cost_usd) VALUES ('2026-11-01T10:00:00.000Z', '2026-11', 'claude', 'm', 'read', 1, 1, 0.5)");
      old.close();
      const log = SpendLog.open(path);
      log.record({ ...call('2026-11-03T10:00:00', 0.25), buildId: 7 });
      log.record({ ...call('2026-11-03T11:00:00', 0.25), buildId: 7 });
      log.record(call('2026-11-03T12:00:00', 1));
      expect(log.build(7)).toEqual({ usd: 0.5, calls: 2 });
      expect(log.month('2026-11').usd).toBeCloseTo(2);
      log.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

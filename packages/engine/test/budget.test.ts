import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelAdapter } from '@aip/models';
import { SpendLog } from '@aip/memory';
import { handleLine, type Deps } from '../src/protocol.ts';

// Obviously fake test value, not a real key.
const FAKE_KEY = 'sk-ant-test-0000000000000000';
const NOW = new Date(2026, 10, 15, 12, 0);

let dir = '';
let dbPath = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aip-budget-'));
  dbPath = join(dir, 'history.sqlite');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(costUsd: number | null, seen: { maxUsd?: number; runs: number } = { runs: 0 }): Deps {
  return {
    async makeAdapter(provider, _key, _settings, maxUsd) {
      seen.maxUsd = maxUsd;
      const run: ModelAdapter['run'] = async () => {
        seen.runs++;
        return { text: 'ready', usage: { inputTokens: 10, outputTokens: 1, costUsd } };
      };
      return { provider, run };
    },
    async pickModel() {
      return 'claude-haiku-5-5';
    },
    async modelName() {
      return 'Haiku 5.5';
    },
    now: () => NOW,
  };
}

const call = async (method: string, params: Record<string, unknown>, d: Deps) =>
  JSON.parse(await handleLine(JSON.stringify({ id: 1, method, params }), d));

const ask = (d: Deps, settings: Record<string, unknown> = {}) =>
  call('ask', { provider: 'claude', apiKey: FAKE_KEY, job: 'read', prompt: 'hi', settings, dbPath }, d);

function spentAlready(usd: number) {
  const log = SpendLog.open(dbPath);
  log.record({ at: NOW, provider: 'claude', model: 'm', job: 'build', inputTokens: 1, outputTokens: 1, costUsd: usd });
  log.close();
}

describe('monthly budget', () => {
  it('records every call’s cost, including unknown ones', async () => {
    await ask(deps(0.25));
    await ask(deps(null));
    const s = (await call('spend_summary', { settings: { gbpPerUsd: 0.8 }, dbPath }, deps(0))).result;
    expect(s).toMatchObject({ month: '2026-11', spentUsd: 0.25, spentGbp: 0.2, calls: 2, unknownCalls: 1, budgetGbp: 20, percentLeft: 99 });
    expect(s.spentText).toBe('£0.20 ($0.25)');
    expect(s.rulesWin).toBe(true);
  });

  it('shows nothing spent as £0.00 ($0.00)', async () => {
    const s = (await call('spend_summary', { settings: {}, dbPath }, deps(0))).result;
    expect(s.spentText).toBe('£0.00 ($0.00)');
    expect(s.percentLeft).toBe(100);
  });

  it('refuses a call once the month’s budget is used up, without calling the model', async () => {
    spentAlready(25); // £20 at 0.8 = $25
    const seen = { runs: 0 };
    const reply = await ask(deps(0.01, seen), { gbpPerUsd: 0.8 });
    expect(reply.error).toBe(
      'This month’s budget is used up (£20.00 ($25.00) of £20). Raise it in Settings → Budget and models, or wait until next month.',
    );
    expect(seen.runs).toBe(0);
  });

  it('caps a call to what is left of the budget', async () => {
    spentAlready(24.9);
    const seen = { runs: 0 } as { maxUsd?: number; runs: number };
    await ask(deps(0.01, seen), { gbpPerUsd: 0.8 });
    expect(seen.maxUsd).toBeCloseTo(0.1);
    const roomy = { runs: 0 } as { maxUsd?: number; runs: number };
    await ask(deps(0.01, roomy), { gbpPerUsd: 0.8, monthlyBudgetGbp: 40 });
    expect(roomy.maxUsd).toBe(0.5);
  });

  it('says below 30% left that joshua’s preferences now win', async () => {
    spentAlready(18); // £14.40 of £20 at 0.8 -> 28% left
    const s = (await call('spend_summary', { settings: { gbpPerUsd: 0.8 }, dbPath }, deps(0))).result;
    expect(s.percentLeft).toBe(28);
    expect(s.rulesWin).toBe(false);
  });

  it('a £0 budget allows no calls', async () => {
    const reply = await ask(deps(0.01), { monthlyBudgetGbp: 0 });
    expect(reply.error).toContain('budget is used up');
  });
});

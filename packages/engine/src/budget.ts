/**
 * The monthly budget: what's been spent this month (from the local spend file) against the £ limit
 * in Settings. Model calls are refused once the budget is used up, and each Claude call is capped
 * to what's left.
 */
import { formatCost, round2 } from './money.ts';
import type { AppSettings } from './settings.ts';

/** Most a single call may cost, even with plenty of budget left (Claude enforces it). */
export const MAX_CALL_USD = 0.5;

/** What the screen says before a paid planning call. Only Claude can be capped up front. */
export function askCostNote(settings: AppSettings, calls = 1): string {
  return settings.provider === 'claude'
    ? `costs up to ${formatCost(MAX_CALL_USD * calls, settings.gbpPerUsd)}`
    : 'costs money; the exact cost shows after it runs';
}

/** Percentage of the monthly £ budget still left, 0-100, one decimal place. */
export function budgetLeftPercent(spentUsd: number, budgetGbp: number, gbpPerUsd: number): number {
  for (const n of [spentUsd, budgetGbp, gbpPerUsd]) if (!Number.isFinite(n)) throw new Error('inputs must be finite');
  if (budgetGbp <= 0 || gbpPerUsd <= 0) throw new Error('budget and rate must be > 0');
  const left = ((budgetGbp - spentUsd * gbpPerUsd) / budgetGbp) * 100;
  return Math.min(100, Math.max(0, Math.round(left * 10) / 10));
}

/** General rules win while more than 30% of the monthly budget is left; below that, joshua's preference wins. */
export function rulesWin(percentLeft: number): boolean {
  return percentLeft > 30;
}

export interface BudgetState {
  month: string;
  spentUsd: number;
  spentGbp: number;
  budgetGbp: number;
  /** $ still available this month (never below 0). */
  leftUsd: number;
  percentLeft: number;
  calls: number;
  unknownCalls: number;
  rulesWin: boolean;
}

export async function readBudget(dbPath: string, settings: AppSettings, now: Date): Promise<BudgetState> {
  const m = await import('@aip/memory');
  const log = m.SpendLog.open(dbPath);
  try {
    const month = log.month(m.monthKey(now));
    const budgetGbp = settings.monthlyBudgetGbp;
    const rate = settings.gbpPerUsd;
    const percentLeft = budgetGbp > 0 ? budgetLeftPercent(month.usd, budgetGbp, rate) : 0;
    return {
      month: month.month,
      spentUsd: month.usd,
      spentGbp: round2(month.usd * rate),
      budgetGbp,
      leftUsd: Math.max(0, budgetGbp / rate - month.usd),
      percentLeft,
      calls: month.calls,
      unknownCalls: month.unknownCalls,
      rulesWin: rulesWin(percentLeft),
    };
  } finally {
    log.close();
  }
}

export async function recordSpend(
  dbPath: string,
  r: { at: Date; provider: string; model: string; job: string; inputTokens: number; outputTokens: number; costUsd: number | null; buildId?: number | null },
): Promise<void> {
  const m = await import('@aip/memory');
  const log = m.SpendLog.open(dbPath);
  try {
    log.record(r);
  } finally {
    log.close();
  }
}

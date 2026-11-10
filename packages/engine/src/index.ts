/** Engine helpers: the "Using:" line and money shown in pounds and dollars. */

export { formatCost } from './money.ts';

export function usingLine(model: string, tools: string[]): string {
  const short = model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2');
  const name = short.charAt(0).toUpperCase() + short.slice(1);
  return `Using: ${[name, ...tools].join(', ')}`;
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

export { ENGINE_VERSION, GBP_PER_USD, costText, handleLine, type Deps } from './protocol.ts';

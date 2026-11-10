/** Money shown in pounds and dollars. */

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** "£0.79 ($1.00)". gbpPerUsd is the day's conversion rate. */
export function formatCost(usd: number, gbpPerUsd: number): string {
  if (!Number.isFinite(usd) || usd < 0) throw new Error('usd must be a finite number >= 0');
  if (!Number.isFinite(gbpPerUsd) || gbpPerUsd <= 0) throw new Error('gbpPerUsd must be a finite number > 0');
  return `£${round2(usd * gbpPerUsd).toFixed(2)} ($${round2(usd).toFixed(2)})`;
}


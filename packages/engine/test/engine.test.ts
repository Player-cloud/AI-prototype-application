import { describe, expect, it } from 'vitest';
import { budgetLeftPercent, formatCost, rulesWin, usingLine } from '../src/index.js';

describe('usingLine', () => {
  it('names the model and tools', () => {
    expect(usingLine('claude-sonnet-5-5', ['code-review', 'Playwright'])).toBe('Using: Sonnet 5.5, code-review, Playwright');
  });
});

describe('money', () => {
  it('formats pounds then dollars', () => {
    expect(formatCost(1, 0.79)).toBe('£0.79 ($1.00)');
    expect(formatCost(0.125, 1)).toBe('£0.13 ($0.13)');
    expect(() => formatCost(-1, 0.8)).toThrow();
    expect(() => formatCost(1, 0)).toThrow();
  });
  it('works out budget left', () => {
    expect(budgetLeftPercent(12.5, 20, 0.8)).toBe(50);
    expect(budgetLeftPercent(100, 20, 0.8)).toBe(0);
    expect(budgetLeftPercent(0, 20, 0.8)).toBe(100);
  });
  it('switches who wins at 30% left', () => {
    expect(rulesWin(31)).toBe(true);
    expect(rulesWin(30)).toBe(false);
  });
});

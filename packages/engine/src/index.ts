/** Engine helpers: the "Using:" line and money shown in pounds and dollars. */

export { formatCost } from './money.ts';

export function usingLine(model: string, tools: string[]): string {
  const short = model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2');
  const name = short.charAt(0).toUpperCase() + short.slice(1);
  return `Using: ${[name, ...tools].join(', ')}`;
}

export { budgetLeftPercent, rulesWin } from './budget.ts';

export { ENGINE_VERSION, GBP_PER_USD, costText, handleLine, type Deps } from './protocol.ts';
export { DEFAULT_SETTINGS, checkSettings, type AppSettings } from './settings.ts';

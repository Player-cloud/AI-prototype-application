/**
 * App settings that aren't secret: which provider to use, the monthly budget, the £/$ rate,
 * model choices for OpenAI and DeepSeek, and their prices. Keys are never in here; they stay in
 * the computer's password store. The Rust shell stores this as settings.json; the engine is the
 * one place that checks it, so a hand-edited or old file can't break the app.
 */
import type { ModelChoice, Price, Provider } from '@aip/models';

export interface AppSettings {
  /** Which provider runs the app's jobs. */
  provider: Provider;
  /** Monthly spending limit in pounds. */
  monthlyBudgetGbp: number;
  /** Pounds per dollar, for showing costs in both. */
  gbpPerUsd: number;
  /** Strong (plans, reviews) and everyday models. Claude's are fixed by the per-job rule. */
  models: { openai: ModelChoice; deepseek: ModelChoice };
  /** USD per million tokens, by model id. Claude reports its own cost, so only OpenAI/DeepSeek need these. */
  prices: Record<string, Price>;
}

/**
 * Starting values. The budget is joshua's agreed £20 a month (it may rise to £40).
 * Model names and the rate are starting guesses to check, not facts.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  provider: 'claude',
  monthlyBudgetGbp: 20,
  gbpPerUsd: 0.79,
  models: {
    openai: { strong: 'gpt-5', everyday: 'gpt-5-mini' },
    deepseek: { strong: 'deepseek-reasoner', everyday: 'deepseek-chat' },
  },
  prices: {},
};

const PROVIDERS: readonly Provider[] = ['claude', 'openai', 'deepseek'];
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const MAX_PRICES = 50;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, label: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`${label} must be a number from ${min} to ${max}`);
  }
  return v;
}

function modelId(v: unknown, label: string): string {
  if (typeof v !== 'string' || !MODEL_ID.test(v.trim())) throw new Error(`${label} must be a model name like deepseek-chat`);
  return v.trim();
}

function choice(v: unknown, fallback: ModelChoice, label: string): ModelChoice {
  if (v === undefined) return { ...fallback };
  if (!isObj(v)) throw new Error(`${label} models must be an object`);
  return {
    strong: v.strong === undefined ? fallback.strong : modelId(v.strong, `${label} strong model`),
    everyday: v.everyday === undefined ? fallback.everyday : modelId(v.everyday, `${label} everyday model`),
  };
}

/**
 * Fills in anything missing with the defaults and checks the rest. Throws a plain-words error on a
 * bad value, so Settings can show what to fix. `{}` (no file yet) gives the defaults.
 */
export function checkSettings(raw: unknown): AppSettings {
  if (raw === undefined || raw === null) raw = {};
  if (!isObj(raw)) throw new Error('settings must be an object');
  const d = DEFAULT_SETTINGS;

  const provider = raw.provider === undefined ? d.provider : (raw.provider as Provider);
  if (!PROVIDERS.includes(provider)) throw new Error(`unknown provider: ${String(raw.provider)}`);

  const models = raw.models === undefined ? {} : raw.models;
  if (!isObj(models)) throw new Error('models must be an object');

  const rawPrices = raw.prices === undefined ? {} : raw.prices;
  if (!isObj(rawPrices)) throw new Error('prices must be an object');
  const entries = Object.entries(rawPrices);
  if (entries.length > MAX_PRICES) throw new Error(`at most ${MAX_PRICES} prices`);
  const prices: Record<string, Price> = {};
  for (const [id, p] of entries) {
    const model = modelId(id, 'price model');
    if (!isObj(p)) throw new Error(`price for ${model} must be an object`);
    prices[model] = {
      inputPerM: num(p.inputPerM, `${model} input price ($ per million tokens)`, 0, 1000),
      outputPerM: num(p.outputPerM, `${model} output price ($ per million tokens)`, 0, 1000),
    };
  }

  return {
    provider,
    monthlyBudgetGbp: raw.monthlyBudgetGbp === undefined ? d.monthlyBudgetGbp : num(raw.monthlyBudgetGbp, 'Monthly budget (£)', 0, 10000),
    gbpPerUsd: raw.gbpPerUsd === undefined ? d.gbpPerUsd : num(raw.gbpPerUsd, '£ per $ rate', 0.1, 5),
    models: {
      openai: choice(models.openai, d.models.openai, 'OpenAI'),
      deepseek: choice(models.deepseek, d.models.deepseek, 'DeepSeek'),
    },
    prices,
  };
}

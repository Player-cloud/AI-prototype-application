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
  /** Folder where the private data repo (ai-prototype-data) is cloned on this computer. '' = not set. */
  dataFolder: string;
  /** joshua's own ask-first rules, added in Settings: any action mentioning `match` waits for his OK. */
  extraRules: ExtraRule[];
  /** The most one feature build run may cost, in pounds (joshua chose £0.80). */
  runCapGbp: number;
  /** Where each project's code is cloned on this computer, by project folder name (slug). */
  codeFolders: Record<string, string>;
  /**
   * Self-maintenance (Q-5). Off unless joshua turns it on. `patchUpdates`: the app may prepare dev-tool
   * patch updates itself (never merged: joshua still presses Keep).
   */
  maintenance: { patchUpdates: boolean };
  /** Simple view: the rail shows only Projects, Build and Settings (for demos and evaluators). Off by default. */
  simpleView: boolean;
}

export interface ExtraRule { match: string; reason: string }

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
  dataFolder: '',
  extraRules: [],
  codeFolders: {},
  maintenance: { patchUpdates: false },
  simpleView: false,
  runCapGbp: 0.8,
};

const PROVIDERS: readonly Provider[] = ['claude', 'openai', 'deepseek'];
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const MAX_PRICES = 50;
const MAX_RULES = 30;
const MAX_CODE_FOLDERS = 50;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

function folderPath(v: unknown, label: string): string {
  if (typeof v !== 'string' || v.length > 500 || /[\r\n\0]/.test(v)) throw new Error(`${label} must be a folder path`);
  return v.trim();
}

function codeFolders(v: unknown): Record<string, string> {
  if (v === undefined) return {};
  if (!isObj(v)) throw new Error('code folders must be an object');
  const entries = Object.entries(v);
  if (entries.length > MAX_CODE_FOLDERS) throw new Error(`at most ${MAX_CODE_FOLDERS} code folders`);
  const out: Record<string, string> = {};
  for (const [slug, path] of entries) {
    if (!SLUG.test(slug)) throw new Error(`“${slug}” isn’t a project folder name`);
    const p = folderPath(path, `Code folder for ${slug}`);
    if (p) out[slug] = p;
  }
  return out;
}

function flag(v: unknown, label: string): boolean {
  if (v === undefined) return false;
  if (typeof v !== 'boolean') throw new Error(`${label} must be on or off`);
  return v;
}

function maintenance(v: unknown): { patchUpdates: boolean } {
  if (v === undefined) return { patchUpdates: false };
  if (!isObj(v)) throw new Error('maintenance must be an object');
  if (v.patchUpdates !== undefined && typeof v.patchUpdates !== 'boolean') throw new Error('Dev-tool patch updates must be on or off');
  return { patchUpdates: v.patchUpdates === true };
}

function extraRules(v: unknown): ExtraRule[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error('extra rules must be a list');
  if (v.length > MAX_RULES) throw new Error(`at most ${MAX_RULES} extra rules`);
  return v.map((r) => {
    if (!isObj(r)) throw new Error('each extra rule needs words to watch for and a reason');
    const match = typeof r.match === 'string' ? r.match.trim() : '';
    const reason = typeof r.reason === 'string' ? r.reason.trim() : '';
    if (match.length < 2 || match.length > 100 || /[\r\n]/.test(match)) {
      throw new Error('Words to watch for must be 2 to 100 characters on one line');
    }
    if (reason.length < 3 || reason.length > 200 || /[\r\n]/.test(reason)) {
      throw new Error('The reason must be 3 to 200 characters on one line');
    }
    return { match, reason };
  });
}

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

  const dataFolder = raw.dataFolder === undefined ? d.dataFolder : folderPath(raw.dataFolder, 'Data folder');

  return {
    provider,
    dataFolder,
    extraRules: extraRules(raw.extraRules),
    codeFolders: codeFolders(raw.codeFolders),
    maintenance: maintenance(raw.maintenance),
    simpleView: flag(raw.simpleView, 'Simple view'),
    runCapGbp: raw.runCapGbp === undefined ? d.runCapGbp : num(raw.runCapGbp, 'Cost limit per build run (£)', 0.05, 50),
    monthlyBudgetGbp: raw.monthlyBudgetGbp === undefined ? d.monthlyBudgetGbp : num(raw.monthlyBudgetGbp, 'Monthly budget (£)', 0, 10000),
    gbpPerUsd: raw.gbpPerUsd === undefined ? d.gbpPerUsd : num(raw.gbpPerUsd, '£ per $ rate', 0.1, 5),
    models: {
      openai: choice(models.openai, d.models.openai, 'OpenAI'),
      deepseek: choice(models.deepseek, d.models.deepseek, 'DeepSeek'),
    },
    prices,
  };
}

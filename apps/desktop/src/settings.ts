import { engine, type Invoke } from './engine';

/** The engine's provider names (the key rows use 'anthropic' for Claude). */
export type EngineProvider = 'claude' | 'openai' | 'deepseek';

export interface ModelChoice { strong: string; everyday: string }
export interface Price { inputPerM: number; outputPerM: number }

/** Non-secret settings. The engine checks them; the Rust shell saves them as settings.json. */
export interface AppSettings {
  provider: EngineProvider;
  monthlyBudgetGbp: number;
  gbpPerUsd: number;
  models: { openai: ModelChoice; deepseek: ModelChoice };
  prices: Record<string, Price>;
  /** Folder where ai-prototype-data is cloned on this computer. '' = not set. */
  dataFolder: string;
  /** joshua's own ask-first rules. */
  extraRules: ExtraRule[];
  /** The most one feature build run may cost, in pounds. */
  runCapGbp: number;
  /** Where each project's code is cloned on this computer, by project folder name. */
  codeFolders: Record<string, string>;
  /** Self-maintenance (Q-5). Off unless joshua turns it on. */
  maintenance: { patchUpdates: boolean };
}

export interface ExtraRule { match: string; reason: string }

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function getSettings(invoke: Invoke): Promise<AppSettings> {
  try {
    return await engine<AppSettings>(invoke, 'settings_check');
  } catch (err) {
    throw new Error(message(err));
  }
}

/** Returns the settings as saved (with any gaps filled), or throws the engine's plain-words reason. */
export async function saveSettings(invoke: Invoke, settings: AppSettings): Promise<AppSettings> {
  try {
    return await invoke<AppSettings>('settings_save', { settings });
  } catch (err) {
    throw new Error(message(err));
  }
}

/**
 * Saves only some fields on top of the latest saved settings, so two parts of the Settings page
 * can't undo each other's changes.
 */
export async function saveSome(invoke: Invoke, change: Partial<AppSettings>): Promise<AppSettings> {
  const latest = await getSettings(invoke);
  return saveSettings(invoke, { ...latest, ...change });
}

/** A rule as Settings shows it. */
export interface RuleView {
  id: string;
  reason: string;
  kind: 'never' | 'ask';
  source: 'gatekeeper' | 'yours';
  match?: string;
}

export async function getRules(invoke: Invoke): Promise<RuleView[]> {
  try {
    const rules = await engine<RuleView[]>(invoke, 'gate_rules');
    return Array.isArray(rules) ? rules : [];
  } catch (err) {
    throw new Error(message(err));
  }
}

/** This month's spend against the budget, from the local spend file. */
export interface SpendSummary {
  month: string;
  spentText: string;
  budgetGbp: number;
  percentLeft: number;
  calls: number;
  unknownCalls: number;
  rulesWin: boolean;
}

export async function getSpend(invoke: Invoke): Promise<SpendSummary | null> {
  try {
    const s = await engine<SpendSummary>(invoke, 'spend_summary');
    return s && typeof s.spentText === 'string' ? s : null;
  } catch {
    return null; // the budget form still works without it
  }
}

/** "Spent this month: £1.20 ($1.52) of £20 · 94% left". */
export function spendLine(s: SpendSummary): string {
  const base = `Spent this month: ${s.spentText} of £${s.budgetGbp} · ${s.percentLeft}% left`;
  const unknown = s.unknownCalls > 0 ? ` · ${s.unknownCalls} call${s.unknownCalls === 1 ? '' : 's'} with no price set` : '';
  const prefs = s.rulesWin ? '' : ' · under 30% left, so your preferences now win over the general rules';
  return base + unknown + prefs;
}

/** "≈ $20.25" for a £ amount at the given rate, or '' when either isn't a usable number. */
export function dollarsFor(gbp: number, gbpPerUsd: number): string {
  if (!Number.isFinite(gbp) || !Number.isFinite(gbpPerUsd) || gbpPerUsd <= 0 || gbp < 0) return '';
  return `≈ $${(gbp / gbpPerUsd).toFixed(2)}`;
}

/** Text box value to number. Blank or junk becomes NaN, which the engine refuses with a plain message. */
export function toNumber(text: string): number {
  return text.trim() === '' ? Number.NaN : Number(text);
}

/** One change in the undo history. */
export interface HistoryItem {
  id: number;
  at: string;
  label: string;
  kind: 'settings' | 'file' | 'approval' | 'revert';
  undoneAt: string | null;
  isUndo: boolean;
}

export async function getHistory(invoke: Invoke): Promise<HistoryItem[]> {
  try {
    const items = await engine<HistoryItem[]>(invoke, 'history_list');
    return Array.isArray(items) ? items : [];
  } catch (err) {
    throw new Error(message(err));
  }
}

/** Undoes one change. Returns a plain-words summary, or throws why it can't. */
export async function undoChange(invoke: Invoke, id: number): Promise<{ kind: 'settings' | 'file'; summary: string }> {
  try {
    return await invoke<{ kind: 'settings' | 'file'; summary: string }>('history_undo', { id });
  } catch (err) {
    throw new Error(message(err));
  }
}

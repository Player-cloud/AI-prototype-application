import type { Invoke } from './engine';

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
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function getSettings(invoke: Invoke): Promise<AppSettings> {
  try {
    return await invoke<AppSettings>('settings_get');
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

/** "≈ $20.25" for a £ amount at the given rate, or '' when either isn't a usable number. */
export function dollarsFor(gbp: number, gbpPerUsd: number): string {
  if (!Number.isFinite(gbp) || !Number.isFinite(gbpPerUsd) || gbpPerUsd <= 0 || gbp < 0) return '';
  return `≈ $${(gbp / gbpPerUsd).toFixed(2)}`;
}

/** Text box value to number. Blank or junk becomes NaN, which the engine refuses with a plain message. */
export function toNumber(text: string): number {
  return text.trim() === '' ? Number.NaN : Number(text);
}

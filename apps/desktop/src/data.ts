import type { Invoke } from './engine';

export type ToolState = 'on' | 'trial' | 'untested' | 'off' | 'unknown';

export interface ToolRow {
  /** Stable ID: the card's file name, or the name as a slug (CI-1). */
  id: string;
  name: string;
  kind: string;
  /** The version in use and the one its evidence is for; null when never seen. */
  version: string | null;
  testedVersion: string | null;
  /** The version on each computer, when more than one has used it (CI-2). */
  byComputer?: string;
  state: ToolState;
  status: string;
  job: string;
  evidence: string;
  rating: string;
  what: string;
  useWhen: string;
  dontUseWhen: string;
  cost: string;
  /** Tool health in plain words ('' when all is well). */
  health: string;
  stale: boolean;
  failuresInRow: number;
  switchedOff: boolean;
}

export type DataOverview =
  | { configured: false }
  | {
      configured: true;
      folder: string;
      tools: ToolRow[];
      habits: string[];
      ruleCount: number;
      noteCount: number;
      firstReadTokens: number;
      allTokens: number;
      /** CI-2: this computer, every computer's last check, what differs, and tool clashes. */
      computer?: string;
      environments?: Environment[];
      differences?: string[];
      clashes?: string[];
    };

/** One computer's last environment check (CI-2). ok null: couldn't tell. */
export interface EnvCheck { name: string; ok: boolean | null; detail: string }
export interface Environment { computer: string; checkedAt: string; os: string; versions: Record<string, string>; checks: EnvCheck[] }
export interface EnvironmentReport { environment: Environment; differences: string[]; synced: string }

/** Checks this computer: free, changes nothing on it. */
export async function checkThisComputer(invoke: Invoke): Promise<EnvironmentReport> {
  try {
    return await invoke<EnvironmentReport>('environment_check');
  } catch (err) {
    throw plain(err);
  }
}

export async function getDataOverview(invoke: Invoke): Promise<DataOverview> {
  try {
    return await invoke<DataOverview>('data_overview');
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
}

export interface SyncResult { committed: boolean; pushed: boolean; summary: string }

function plain(err: unknown): Error {
  return new Error(err instanceof Error ? err.message : String(err));
}

export async function rateTool(invoke: Invoke, tool: string, rating: number): Promise<SyncResult> {
  try {
    return await invoke<SyncResult>('tool_rate', { tool, rating });
  } catch (err) {
    throw plain(err);
  }
}

/** Switches a switched-off tool back on; it gets a quick retest next time it's used. */
export async function switchToolOn(invoke: Invoke, tool: string): Promise<SyncResult> {
  try {
    return await invoke<SyncResult>('tool_switch_on', { tool });
  } catch (err) {
    throw plain(err);
  }
}

export async function syncData(invoke: Invoke): Promise<SyncResult> {
  try {
    return await invoke<SyncResult>('data_sync');
  } catch (err) {
    throw plain(err);
  }
}

export const STATE_LABEL: Record<ToolState, string> = {
  on: 'On',
  trial: 'Trial next',
  untested: 'Not tested',
  off: 'Off',
  unknown: 'Unknown',
};

/** Share of tokens saved by reading summaries first, e.g. 0.93 -> "93%". */
export function savedPercent(first: number, all: number): string {
  if (all <= 0 || first >= all) return '0%';
  return `${Math.round((1 - first / all) * 100)}%`;
}

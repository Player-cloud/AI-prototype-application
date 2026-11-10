import type { Invoke } from './engine';

export type ToolState = 'on' | 'trial' | 'untested' | 'off' | 'unknown';

export interface ToolRow {
  name: string;
  state: ToolState;
  status: string;
  job: string;
  evidence: string;
  rating: string;
  what: string;
  useWhen: string;
  dontUseWhen: string;
  cost: string;
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
    };

export async function getDataOverview(invoke: Invoke): Promise<DataOverview> {
  try {
    return await invoke<DataOverview>('data_overview');
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
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

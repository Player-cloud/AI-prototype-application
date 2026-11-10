/** What the Tools screen shows: the data repo's tools, habits and rules, read through the memory package. */
import type { ToolState } from '@aip/memory';
import type { AppSettings } from './settings.ts';

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

export async function dataOverview(settings: AppSettings): Promise<DataOverview> {
  if (!settings.dataFolder) return { configured: false };
  const m = await import('@aip/memory');
  const repo = await m.loadDataRepo(settings.dataFolder);
  return {
    configured: true,
    folder: repo.folder,
    tools: repo.tools.map((t) => ({
      name: t.name,
      state: t.state,
      status: t.status,
      job: t.job,
      evidence: t.evidence,
      rating: t.rating,
      what: t.card?.what ?? '',
      useWhen: t.card?.useWhen ?? '',
      dontUseWhen: t.card?.dontUseWhen ?? '',
      cost: t.card?.cost ?? '',
    })),
    habits: repo.habits,
    ruleCount: repo.rules.length,
    noteCount: repo.notes.length,
    firstReadTokens: m.roughTokens(m.firstRead(repo)),
    allTokens: m.roughTokens(repo.notes.map((n) => n.body).join('\n')),
  };
}

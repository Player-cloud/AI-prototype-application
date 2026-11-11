import type { Invoke } from './engine';

export type StageId = 'idea' | 'audience' | 'features' | 'checklist' | 'look' | 'tech' | 'done';

export interface Question { id: string; text: string; hint?: string; required?: boolean }
export interface Stage { id: StageId; title: string; intro: string; questions: Question[] }
export interface Feature { id: string; name: string; what: string }

export interface Interview {
  name: string;
  slug: string;
  current: StageId;
  confirmed: StageId[];
  text: Record<string, string>;
  areas: string[];
  features: Feature[];
  done: Record<string, string[]>;
  specAt: string | null;
  updatedAt: string;
}

export interface ToolHint { name: string; state: string; job: string }

export interface InterviewView {
  interview: Interview;
  missing: string[];
  tools: ToolHint[];
  big: boolean;
  finished: boolean;
}

export interface ProjectRow { slug: string; name: string; status: string; finished: boolean; updatedAt: string }

export interface Patch {
  text?: Record<string, string>;
  areas?: string[];
  features?: { id?: string; name: string; what: string }[];
  done?: Record<string, string[]>;
}

/** Calls one of the engine's project methods through the shell; errors come back in plain words. */
async function call<T>(invoke: Invoke, method: string, params: Record<string, unknown> = {}): Promise<T> {
  try {
    return await invoke<T>('project', { method, params });
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
}

export const getStages = (invoke: Invoke) => call<{ stages: Stage[]; areas: string[] }>(invoke, 'interview_stages');
export const listProjects = (invoke: Invoke) => call<ProjectRow[]>(invoke, 'project_list');
export const startProject = (invoke: Invoke, name: string) => call<InterviewView>(invoke, 'interview_start', { name });
export const openProject = (invoke: Invoke, slug: string, stage?: StageId) => call<InterviewView>(invoke, 'interview_get', { slug, stage });
export const saveAnswers = (invoke: Invoke, slug: string, stage: StageId, patch: Patch) =>
  call<InterviewView>(invoke, 'interview_save', { slug, stage, patch });
export const confirmStage = (invoke: Invoke, slug: string, stage: StageId) =>
  call<{ view: InterviewView; files: string[]; summary: string }>(invoke, 'interview_confirm', { slug, stage });

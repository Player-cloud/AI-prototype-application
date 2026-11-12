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
  review: PlanReview | null;
}

export interface Finding { reviewer: string; severity: 'must' | 'should' | 'could'; text: string; feature?: string }
export interface PlanReview { at: string; big: boolean; findings: Finding[]; costText: string }

export interface ToolHint { name: string; state: string; job: string }

export interface InterviewView {
  interview: Interview;
  missing: string[];
  tools: ToolHint[];
  big: boolean;
  finished: boolean;
  /** e.g. "costs up to £0.40 ($0.50)". */
  askCost: string;
  reviewers: number;
  reviewCost: string;
  reviewCurrent: boolean;
}

export interface Suggestions {
  questions: string[];
  areas: string[];
  features: { name: string; what: string }[];
  done: Record<string, string[]>;
}

export interface SuggestResult { suggestions: Suggestions; modelName: string; costText: string }

/** Claude's ideas for a stage. Costs money; nothing is added until joshua picks it. */
export async function suggest(invoke: Invoke, slug: string, stage: StageId): Promise<SuggestResult> {
  try {
    return await invoke<SuggestResult>('interview_suggest', { slug, stage });
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
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

export interface RunInfo { path: string; branch: string; feature: string }
export interface CodeFolderStatus { folder: string; branch: string; clean: boolean; runs: RunInfo[] }
export const checkCodeFolder = (invoke: Invoke, slug: string) => call<CodeFolderStatus>(invoke, 'code_folder_check', { slug });
/** Makes a new empty git repo at `path` (only when it's empty or missing), so nothing needs cloning first. */
export const createCodeFolder = (invoke: Invoke, slug: string, path: string) => call<CodeFolderStatus>(invoke, 'code_folder_create', { slug, path });

/** Reviews the finished plan (one review, or three fresh-eyes reviewers for a big build). Costs money. */
export async function reviewPlan(invoke: Invoke, slug: string): Promise<{ view: InterviewView; summary: string }> {
  try {
    return await invoke<{ view: InterviewView; summary: string }>('interview_review', { slug });
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
}

/** CI-7: one tool the app knows, whether it suggests it for this project and why, and joshua's choice. */
export interface ProjectToolRow { id: string; name: string; kind: string; suggested: boolean; why: string; approved: boolean }
export interface ProjectTools { slug: string; approved: string[] | null; rows: ProjectToolRow[]; rules: string[] }

/** CI-7: the project's approved tools, the app's suggestions and its own rules (free). */
export async function getProjectTools(invoke: Invoke, slug: string): Promise<ProjectTools> {
  try {
    return await invoke<ProjectTools>('project_tools', { slug });
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
}

/** CI-7: saves joshua's choice of tools for this project (undo it from History). */
export async function approveProjectTools(invoke: Invoke, slug: string, tools: string[]): Promise<ProjectTools & { summary: string; synced: string }> {
  try {
    return await invoke<ProjectTools & { summary: string; synced: string }>('project_tools_approve', { slug, tools });
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
}

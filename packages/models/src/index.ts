/**
 * Model adapter layer. One setting picks the provider; every adapter has the same shape.
 * Model choice per job comes from the tool trials (2026-11-10) and joshua's decisions.
 */

export type Provider = 'claude' | 'openai' | 'deepseek';
export type Job = 'plan' | 'final-review' | 'security-review' | 'build' | 'read' | 'summarise' | 'small-code' | 'code-review' | 'write-tests' | 'plan-review';

export interface Usage { inputTokens: number; outputTokens: number; costUsd: number }
export interface StepResult { text: string; usage: Usage }

export interface ModelAdapter {
  provider: Provider;
  run(task: { job: Job; prompt: string; model: string }): Promise<StepResult>;
}

/** Claude model for each job (Opus plans and reviews, Sonnet builds, Haiku reads, tests and reviews code). */
export const CLAUDE_MODEL_BY_JOB: Record<Job, string> = {
  plan: 'claude-opus-5-5',
  'final-review': 'claude-opus-5-5',
  'security-review': 'claude-opus-5-5',
  'plan-review': 'claude-sonnet-5-5',
  build: 'claude-sonnet-5-5',
  read: 'claude-haiku-5-5',
  summarise: 'claude-haiku-5-5',
  'small-code': 'claude-haiku-5-5',
  'code-review': 'claude-haiku-5-5',
  'write-tests': 'claude-haiku-5-5',
};

/** Jobs that move up a tier when the change is security-sensitive or spans several files. */
const ESCALATE: Partial<Record<Job, string>> = {
  'code-review': 'claude-sonnet-5-5',
  'small-code': 'claude-sonnet-5-5',
  'write-tests': 'claude-sonnet-5-5',
};

export function pickClaudeModel(job: Job, opts: { sensitive?: boolean; multiFile?: boolean } = {}): string {
  if ((opts.sensitive || opts.multiFile) && ESCALATE[job]) return ESCALATE[job]!;
  return CLAUDE_MODEL_BY_JOB[job];
}

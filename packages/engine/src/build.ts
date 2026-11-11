/**
 * Step 8b: one feature build. The engine makes the feature's own copy of the code (8a), shows the
 * Using line, then lets the build model (Sonnet for Claude) work in that copy. Every tool call is
 * checked first: it must stay inside the copy, and it goes through the gatekeeper. A run stops at
 * its cost limit (joshua chose £0.80 by default) or what's left of the month's budget.
 */
import { isAbsolute, relative, resolve } from 'node:path';
import type { ModelAdapter, Provider, ToolDecision } from '@aip/models';
import { readBudget, recordSpend } from './budget.ts';
import { gate } from './gate.ts';
import { usingLine } from './using.ts';
import type { Interview } from './interview.ts';
import { getInterview } from './projects.ts';
import { specText } from './review.ts';
import { startRun, type StartedRun } from './runs.ts';
import type { AppSettings } from './settings.ts';

export interface BuildDeps {
  makeAdapter(provider: Provider, apiKey: string, settings: AppSettings, maxUsd: number): Promise<ModelAdapter>;
  pickModel(provider: Provider, job: 'build', settings: AppSettings): Promise<string>;
  modelName(id: string): Promise<string>;
  now?(): Date;
}

export interface BuildStep { text: string; refused?: string }

/** What a running build reports as it goes. */
export type BuildEvent = { type: 'using'; using: string; run: StartedRun } | ({ type: 'step' } & BuildStep);

export interface BuildResult {
  run: StartedRun;
  using: string;
  steps: BuildStep[];
  /** What the model said it did. */
  summary: string;
  model: string;
  costUsd: number | null;
}

/** The run's limit in dollars: the Settings limit (in £) or what's left this month, whichever is less. */
export function runCapUsd(settings: AppSettings, leftUsd: number | null): number {
  const cap = settings.runCapGbp / settings.gbpPerUsd;
  return leftUsd === null ? cap : Math.min(cap, leftUsd);
}

export function buildPrompt(iv: Interview, feature: string, spec: string): string {
  const f = iv.features.find((x) => x.id === feature);
  return [
    `Build feature ${feature}${f ? ` (${f.name})` : ''} of the web app "${iv.name}", and only that feature.`,
    'You are working in a separate copy of the project’s repo; it is your current folder. Change files only here.',
    `Build it so every check in done/${feature}.md passes. Add or update tests for it, and run them.`,
    'Keep changes small. Don’t push, deploy, install things globally or call outside services: those need joshua’s OK and will be refused.',
    'Never read or write key files (.env, *.pem).',
    'When you’re done, reply with a short plain-words summary of what you changed and what the tests showed.',
    '',
    spec,
  ].join('\n');
}

const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const;

const inside = (runPath: string, p: string) => {
  // A Windows drive or network path can't be inside the copy on Linux.
  if (process.platform !== 'win32' && /^([A-Za-z]:[\\/]|\\\\)/.test(p)) return false;
  const rel = relative(resolve(runPath), resolve(runPath, p));
  return !(rel.startsWith('..') || isAbsolute(rel));
};

/** Path-like words in a shell command: absolute paths, ~, and anything climbing out with "..". */
function commandPaths(command: string): string[] {
  return command
    .split(/[\s;|&<>()'"`=]+/)
    .filter((w) => /^(\/|~|[A-Za-z]:[\\/]|\\\\)/.test(w) || /(^|[\\/])\.\.([\\/]|$)/.test(w));
}

/**
 * True when every path the tool names is inside the run's copy. For shell commands this is a
 * best-effort check of the paths written in the command (absolute paths, ~ and ".." are refused
 * unless they point inside the copy).
 */
export function staysInside(runPath: string, input: Record<string, unknown>): boolean {
  for (const k of PATH_KEYS) {
    const v = input[k];
    if (typeof v === 'string' && v !== '' && !inside(runPath, v)) return false;
  }
  if (typeof input.command === 'string') {
    for (const w of commandPaths(input.command)) if (w.startsWith('~') || !inside(runPath, w)) return false;
  }
  return true;
}

/** The check before every tool call: inside the copy, then the gatekeeper. */
export function checkStep(settings: AppSettings, runPath: string, tool: string, input: Record<string, unknown>): ToolDecision {
  if (!staysInside(runPath, input)) return { allow: false, reason: 'Only files in this feature’s own copy can be used.' };
  const d = gate(tool, input, settings);
  if (d.allow) return d;
  return { allow: false, reason: d.askJoshua ? `${d.reason}. Not done; joshua will be asked later.` : d.reason };
}

export async function buildFeature(
  settings: AppSettings,
  p: { slug: string; feature: string; provider: Provider; apiKey: string; dbPath: string | null },
  deps: BuildDeps,
  onEvent?: (e: BuildEvent) => void,
  signal?: AbortSignal,
): Promise<BuildResult> {
  if (signal?.aborted) throw new Error('Stopped.');
  const now = deps.now?.() ?? new Date();
  let leftUsd: number | null = null;
  if (p.dbPath) {
    const b = await readBudget(p.dbPath, settings, now);
    if (b.leftUsd <= 0) throw new Error(`This month’s budget is used up (£${b.spentGbp} of £${b.budgetGbp}). Raise it in Settings, or wait until next month.`);
    leftUsd = b.leftUsd;
  }
  const adapter = await deps.makeAdapter(p.provider, p.apiKey, settings, runCapUsd(settings, leftUsd));
  if (!adapter.build) throw new Error('Building needs Claude for now. Choose Claude in Settings → Budget and models.');
  const { interview } = await getInterview(settings, p.slug);
  const run = await startRun(settings, p.slug, p.feature, now);
  const model = await deps.pickModel(p.provider, 'build', settings);
  const using = usingLine(model, ['file edits', 'shell']);
  onEvent?.({ type: 'using', using, run });
  const steps: BuildStep[] = [];
  const add = (s: BuildStep) => {
    steps.push(s);
    onEvent?.({ type: 'step', ...s });
  };
  const prompt = buildPrompt(interview, p.feature, specText(interview, new Date(interview.specAt ?? now)));
  const out = await adapter.build({
    model,
    prompt,
    cwd: run.path,
    signal,
    onStep: (text) => add({ text }),
    async checkTool(tool, input) {
      const d = checkStep(settings, run.path, tool, input);
      if (!d.allow) add({ text: `Refused: ${tool}`, refused: d.reason });
      return d;
    },
  });
  if (p.dbPath) await recordSpend(p.dbPath, { at: now, provider: p.provider, model, job: 'build', ...out.usage });
  return { run, using, steps, summary: out.text.trim().slice(0, 2000), model, costUsd: out.usage.costUsd };
}

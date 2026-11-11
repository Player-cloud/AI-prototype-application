/**
 * The engine helper talks to the window over stdin/stdout, one JSON object per line.
 * Request:  {"id": 1, "method": "ping"}
 * Reply:    {"id": 1, "result": {...}}  or  {"id": 1, "error": "..."}
 *
 * Methods:
 *  - ping: is the engine up?
 *  - ask:  {provider, apiKey, job, prompt} -> {text, model, modelName, inputTokens, outputTokens, costUsd, costText}
 *  - check: {provider, apiKey} -> {ok, summary}. Claude: a one-word ask. OpenAI/DeepSeek: the free "list models" call.
 *  - settings_check: {settings} -> the settings with defaults filled in, or a plain-words error.
 *  - gate_check: {settings, tool, input} -> {allow} or {allow:false, reason, askJoshua}. Every risky step asks this first.
 *  - gate_rules: {settings} -> the ask-first rules in plain words, for Settings.
 *  - spend_summary: {settings, dbPath} -> this month's spend against the budget.
 *    ask and check take an optional dbPath: the call is refused once the month's budget is used up,
 *    and its cost is recorded there afterwards.
 *  - data_overview: {settings} -> the tools, habits and rules in the data folder, and what the engine reads first.
 *  - tool_rate: {settings, tool, rating} -> saves a 1–5 rating in ledger.md and syncs the data repo.
 *    With dbPath, the change is kept in the history so it can be undone.
 *  - data_sync: {settings} -> commits data folder changes and syncs with GitHub. Never forces.
 *  - interview_stages: {} -> the plan interview's stages, questions and checklist areas.
 *  - project_list: {settings} -> the projects in the data folder with their status.
 *  - interview_start: {settings, name} -> starts a project's plan interview in projects/<slug>/.
 *  - interview_get / interview_save: {settings, slug, stage?, patch?} -> the interview (saving answers first).
 *  - interview_suggest: {settings, slug, stage, provider, apiKey, dbPath} -> Claude's ideas for the stage
 *    (questions, areas, features or done checks), with the cost. Uses the "plan" job; nothing is saved.
 *  - interview_review: {settings, slug, provider, apiKey, dbPath} -> reviews the finished spec: one
 *    plan review, or 3 fresh-eyes reviewers for a big build. Saves review.md and syncs.
 *  - code_folder_check: {settings, slug} -> checks the project's code folder on this computer (a git
 *    repo with a commit) and lists its feature runs (worktrees on aip/ branches).
 *  - build_feature: {settings, slug, feature, provider, apiKey, dbPath} -> builds one feature in its own
 *    copy of the code (Sonnet for Claude). Every tool call stays in the copy and goes through the
 *    gatekeeper. Stops at the run's cost limit. Then runs the project's tests, with up to 2 fix
 *    attempts inside the limit. Returns the run, the Using line, steps, tests, sync note and cost.
 *    While it runs, event lines {"id", "event"} come first: {type:"using"}, then {type:"step"} each.
 *    A model that fails 3 runs in a row is switched off (D-2) and refused until switched back on.
 *  - run_list: {dbPath, slug?} -> saved feature builds, newest first (waiting, kept or undone, rating).
 *  - run_keep: {settings, dbPath, id} -> merges a build whose tests pass into joshua's own copy (never
 *    pushes), then removes the build's copy. Refused when his copy has uncommitted changes.
 *  - run_undo: {settings, dbPath, id} -> removes a waiting build's copy and branch.
 *  - run_rate: {dbPath, id, rating} -> joshua's 1–5 rating for a build.
 *  - tool_switch_on: {settings, tool} -> switches a switched-off tool back on (retested on next use)
 *    and syncs the data repo.
 *  - cancel: {id} -> stops that running request (answered at once, not queued).
 *  - interview_confirm: {settings, slug, stage} -> confirms a stage; the last one writes spec.md and
 *    the done files, then syncs the data repo.
 *  - settings_saved: {dbPath, before, after, undoes?} -> keeps a settings change in the history (id, or null if nothing changed).
 *  - history_list: {dbPath} -> the newest changes, newest first.
 *  - undo: {dbPath, id, settings} -> puts a change back if nothing has changed since. For settings it
 *    returns the earlier settings for the shell to save (then settings_saved with undoes).
 *    Both refuse to push anything key-shaped.
 *    ask and check also take an optional `settings` (model choices, prices, £/$ rate).
 *    The key comes from the window's password store for this one call and is never echoed back.
 */
import type { CheckResult } from '@aip/checks';
import type { Job, ModelAdapter, Provider } from '@aip/models';
import { formatCost } from './money.ts';
import { DEFAULT_SETTINGS, checkSettings, type AppSettings } from './settings.ts';
import { keepRun, listRuns, rateRun, undoRun } from './keep.ts';
import { dataOverview, rateAndSync, switchToolOn, syncAfterUndo, syncNow } from './data.ts';
import { historyList, settingsSaved, undoStart } from './history.ts';
import { parseSuggestions, suggestPrompt } from './suggest.ts';
import { stageOf } from './interview.ts';
import { reviewPrompt, reviewersFor, parseFindings, specText, type Finding } from './review.ts';
import { bigBuild } from './interview.ts';
import { interviewForReview, recordReview } from './projects.ts';
import { confirm, getInterview, interviewStages, listProjects, saveAnswers, startInterview } from './projects.ts';
import { MAX_CALL_USD, readBudget, recordSpend } from './budget.ts';
import { gate, listRules } from './gate.ts';
import { checkCodeFolder, codeFolderOf } from './runs.ts';
import { buildFeature } from './build.ts';

export const ENGINE_VERSION = '0.0.1';

/** £ per $ used when no rate has been set in Settings. */
export const GBP_PER_USD = DEFAULT_SETTINGS.gbpPerUsd;

export interface Request {
  id: number;
  method: string;
  params?: unknown;
}

export type Reply = { id: number | null; result: unknown } | { id: number | null; error: string };

/** What `ask` needs from the models package. Swapped for fakes in tests. */
export interface Deps {
  /** maxUsd caps a single call (Claude enforces it; others can't be capped up front). */
  makeAdapter(provider: Provider, apiKey: string, settings: AppSettings, maxUsd: number): Promise<ModelAdapter>;
  pickModel(provider: Provider, job: Job, settings: AppSettings): Promise<string>;
  modelName(id: string): Promise<string>;
  /** The time now; swapped in tests. */
  now?(): Date;
  /** Runs a project's tests after a build (8d); the real one is @aip/checks. Swapped in tests. */
  runTests?(dir: string): Promise<CheckResult>;
}


/** Loads the models package only when a model is first used. */
export const realDeps: Deps = {
  async makeAdapter(provider, apiKey, settings, maxUsd) {
    const m = await import('@aip/models');
    if (provider === 'claude') return m.createClaudeAdapter({ apiKey, maxBudgetUsd: maxUsd });
    return m.createOpenAICompatibleAdapter({ provider, apiKey, prices: settings.prices });
  },
  async pickModel(provider, job, settings) {
    const choice = provider === 'claude' ? undefined : settings.models[provider];
    return (await import('@aip/models')).pickModel(provider, job, {}, choice);
  },
  async modelName(id) {
    return (await import('@aip/models')).modelName(id);
  },
};

const PROVIDERS: readonly Provider[] = ['claude', 'openai', 'deepseek'];
const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude', openai: 'OpenAI', deepseek: 'DeepSeek' };

const JOBS: readonly Job[] = ['plan', 'final-review', 'security-review', 'build', 'read', 'summarise', 'small-code', 'code-review', 'write-tests', 'plan-review'];

export const COST_UNKNOWN = 'cost unknown (add this model’s price in Settings)';

/** "under £0.01 (under $0.01)" for tiny amounts, otherwise "£0.79 ($1.00)". Null means the price isn't known yet. */
export function costText(usd: number | null, gbpPerUsd = GBP_PER_USD): string {
  if (usd === null) return COST_UNKNOWN;
  return usd * gbpPerUsd < 0.005 ? 'under £0.01 (under $0.01)' : formatCost(usd, gbpPerUsd);
}

function str(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== 'string' || v === '') throw new Error(`${key} is required`);
  return v;
}

function optionalPath(p: Record<string, unknown>, key: string): string | null {
  const v = p[key];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new Error(`${key} must be a path`);
  return v;
}

function undoesOf(v: unknown): { id: number; label: string } | undefined {
  if (v === undefined || v === null) return undefined;
  const u = obj(v);
  if (typeof u.id !== 'number' || !Number.isInteger(u.id) || typeof u.label !== 'string') throw new Error('undoes must have id and label');
  return { id: u.id, label: u.label };
}

function optionalStage(p: Record<string, unknown>): string | undefined {
  return typeof p.stage === 'string' && p.stage ? p.stage : undefined;
}

function settingsOrNull(raw: unknown): AppSettings | null {
  try {
    return checkSettings(raw);
  } catch {
    return null;
  }
}

function obj(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null) throw new Error('params must be an object');
  return params as Record<string, unknown>;
}

function provider(p: Record<string, unknown>): Provider {
  const v = str(p, 'provider') as Provider;
  if (!PROVIDERS.includes(v)) throw new Error(`unknown provider: ${v}`);
  return v;
}

async function runAsk(p: Record<string, unknown>, deps: Deps) {
  const settings = checkSettings(p.settings);
  const prov = provider(p);
  const apiKey = str(p, 'apiKey');
  const prompt = str(p, 'prompt');
  const job = str(p, 'job') as Job;
  if (!JOBS.includes(job)) throw new Error(`unknown job: ${job}`);
  const dbPath = optionalPath(p, 'dbPath');
  const now = deps.now?.() ?? new Date();
  let maxUsd = MAX_CALL_USD;
  if (dbPath) {
    const b = await readBudget(dbPath, settings, now);
    if (b.leftUsd <= 0) {
      throw new Error(
        `This month’s budget is used up (${costText(b.spentUsd, settings.gbpPerUsd)} of £${b.budgetGbp}). Raise it in Settings → Budget and models, or wait until next month.`,
      );
    }
    maxUsd = Math.min(MAX_CALL_USD, b.leftUsd);
  }
  const model = await deps.pickModel(prov, job, settings);
  const adapter = await deps.makeAdapter(prov, apiKey, settings, maxUsd);
  const out = await adapter.run({ job, prompt, model });
  if (dbPath) {
    await recordSpend(dbPath, { at: now, provider: prov, model, job, ...out.usage });
  }
  return {
    text: out.text,
    model,
    modelName: await deps.modelName(model),
    inputTokens: out.usage.inputTokens,
    outputTokens: out.usage.outputTokens,
    costUsd: out.usage.costUsd,
    costText: costText(out.usage.costUsd, settings.gbpPerUsd),
  };
}

const ask = (params: unknown, deps: Deps) => runAsk(obj(params), deps);

/** "Test connection" in Settings. Free where the provider allows it. */
async function check(params: unknown, deps: Deps): Promise<{ ok: true; summary: string }> {
  const p = obj(params);
  const prov = provider(p);
  const apiKey = str(p, 'apiKey');
  const settings = checkSettings(p.settings);
  const adapter = await deps.makeAdapter(prov, apiKey, settings, MAX_CALL_USD);
  if (adapter.checkKey) {
    await adapter.checkKey();
    return { ok: true, summary: `Connected. ${PROVIDER_NAME[prov]} accepted the key. This check is free.` };
  }
  const r = await runAsk(
    { provider: prov, apiKey, settings, dbPath: p.dbPath, job: 'read', prompt: 'Reply with the single word: ready' },
    deps,
  );
  return { ok: true, summary: `Connected. ${r.modelName} replied “${r.text.trim()}”. Cost: ${r.costText}.` };
}

/** For long requests: events sent before the reply (one line each), and a signal to stop early. */
export interface Live {
  emit?(event: unknown): void;
  signal?: AbortSignal;
}

type Handler = (params: unknown, deps: Deps, live: Live) => unknown;

const HANDLERS: Record<string, Handler> = {
  ping: () => ({ ok: true, version: ENGINE_VERSION }),
  ask,
  check,
  settings_check: (params) => checkSettings(obj(params).settings),
  gate_check: (params) => {
    const p = obj(params);
    return gate(str(p, 'tool'), p.input, checkSettings(p.settings));
  },
  gate_rules: (params) => listRules(checkSettings(obj(params).settings)),
  spend_summary: async (params, deps) => {
    const p = obj(params);
    const settings = checkSettings(p.settings);
    const dbPath = optionalPath(p, 'dbPath');
    if (!dbPath) throw new Error('dbPath is required');
    const b = await readBudget(dbPath, settings, deps.now?.() ?? new Date());
    const spentText = b.spentUsd === 0 ? formatCost(0, settings.gbpPerUsd) : costText(b.spentUsd, settings.gbpPerUsd);
    return { ...b, spentText };
  },
  data_overview: (params) => dataOverview(checkSettings(obj(params).settings)),
  tool_rate: (params, deps) => {
    const p = obj(params);
    const rating = p.rating;
    if (typeof rating !== 'number') throw new Error('Rating must be a whole number from 1 to 5');
    return rateAndSync(checkSettings(p.settings), str(p, 'tool'), rating, optionalPath(p, 'dbPath'), deps.now?.() ?? new Date());
  },
  settings_saved: (params, deps) => {
    const p = obj(params);
    return settingsSaved(str(p, 'dbPath'), p.before, p.after, deps.now?.() ?? new Date(), undoesOf(p.undoes));
  },
  interview_stages: () => interviewStages(),
  project_list: (params) => listProjects(checkSettings(obj(params).settings)),
  interview_start: (params, deps) => {
    const p = obj(params);
    return startInterview(checkSettings(p.settings), p.name, deps.now?.() ?? new Date());
  },
  interview_get: (params) => {
    const p = obj(params);
    return getInterview(checkSettings(p.settings), str(p, 'slug'), optionalStage(p));
  },
  interview_save: (params, deps) => {
    const p = obj(params);
    return saveAnswers(checkSettings(p.settings), str(p, 'slug'), obj(p.patch ?? {}), optionalStage(p), deps.now?.() ?? new Date());
  },
  interview_suggest: async (params, deps) => {
    const p = obj(params);
    const stage = stageOf(str(p, 'stage')).id;
    const { interview } = await getInterview(checkSettings(p.settings), str(p, 'slug'), stage);
    const r = await runAsk(
      { provider: p.provider, apiKey: p.apiKey, settings: p.settings, dbPath: p.dbPath, job: 'plan', prompt: suggestPrompt(interview, stage) },
      deps,
    );
    return { suggestions: parseSuggestions(r.text, interview, stage), modelName: r.modelName, costText: r.costText };
  },
  interview_review: async (params, deps) => {
    const p = obj(params);
    const settings = checkSettings(p.settings);
    const iv = await interviewForReview(settings, str(p, 'slug'));
    const now = deps.now?.() ?? new Date();
    const spec = specText(iv, new Date(iv.specAt ?? now));
    const findings: Finding[] = [];
    let usd: number | null = 0;
    // Each reviewer is a separate call with only the spec: fresh eyes.
    for (const r of reviewersFor(bigBuild(iv))) {
      const out = await runAsk(
        { provider: p.provider, apiKey: p.apiKey, settings: p.settings, dbPath: p.dbPath, job: 'plan-review', prompt: reviewPrompt(spec, r) },
        deps,
      );
      usd = usd === null || out.costUsd === null ? null : usd + out.costUsd;
      findings.push(...parseFindings(out.text, r.id, iv.features.map((f) => f.id)));
    }
    return recordReview(settings, iv, findings, costText(usd, settings.gbpPerUsd), now);
  },
  interview_confirm: (params, deps) => {
    const p = obj(params);
    return confirm(checkSettings(p.settings), str(p, 'slug'), str(p, 'stage'), deps.now?.() ?? new Date());
  },
  build_feature: async (params, deps, live) => {
    const p = obj(params);
    const settings = checkSettings(p.settings);
    const r = await buildFeature(
      settings,
      { slug: str(p, 'slug'), feature: str(p, 'feature'), provider: provider(p), apiKey: str(p, 'apiKey'), dbPath: optionalPath(p, 'dbPath') },
      deps,
      (e) => live.emit?.(e),
      live.signal,
    );
    return { ...r, modelName: await deps.modelName(r.model), costText: costText(r.costUsd, settings.gbpPerUsd) };
  },
  code_folder_check: (params) => {
    const p = obj(params);
    const settings = checkSettings(p.settings);
    return checkCodeFolder(codeFolderOf(settings, str(p, 'slug')));
  },
  history_list: (params) => historyList(str(obj(params), 'dbPath')),
  undo: async (params, deps) => {
    const p = obj(params);
    const id = p.id;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) throw new Error('id must be a whole number');
    const r = await undoStart(str(p, 'dbPath'), id, p.settings, deps.now?.() ?? new Date());
    if (r.kind === 'file') {
      const synced = await syncAfterUndo(settingsOrNull(p.settings) ?? DEFAULT_SETTINGS, r.path, r.label);
      return { ...r, summary: synced ? `${r.summary} ${synced}` : r.summary };
    }
    return r;
  },
  data_sync: (params) => syncNow(checkSettings(obj(params).settings)),
  run_list: (params) => {
    const p = obj(params);
    return listRuns(str(p, 'dbPath'), typeof p.slug === 'string' && p.slug ? p.slug : undefined);
  },
  run_keep: (params, deps) => {
    const p = obj(params);
    return keepRun(checkSettings(p.settings), str(p, 'dbPath'), runId(p), deps.now?.() ?? new Date());
  },
  run_undo: (params, deps) => {
    const p = obj(params);
    return undoRun(checkSettings(p.settings), str(p, 'dbPath'), runId(p), deps.now?.() ?? new Date());
  },
  run_rate: (params) => {
    const p = obj(params);
    if (typeof p.rating !== 'number') throw new Error('Rating must be a whole number from 1 to 5');
    return rateRun(str(p, 'dbPath'), runId(p), p.rating);
  },
  tool_switch_on: (params) => {
    const p = obj(params);
    return switchToolOn(checkSettings(p.settings), str(p, 'tool'));
  },
};

function runId(p: Record<string, unknown>): number {
  if (typeof p.id !== 'number' || !Number.isInteger(p.id) || p.id < 1) throw new Error('id must be a build number');
  return p.id;
}

function parseRequest(line: string): Request | string {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return 'bad JSON';
  }
  if (typeof value !== 'object' || value === null) return 'request must be an object';
  const { id, method, params } = value as Record<string, unknown>;
  if (typeof id !== 'number' || !Number.isInteger(id)) return 'id must be a whole number';
  if (typeof method !== 'string') return 'method must be a string';
  return { id, method, params };
}

/** Turns one line of input into one line of output. Never rejects. */
export async function handleLine(line: string, deps: Deps = realDeps, live: Live = {}): Promise<string> {
  const req = parseRequest(line);
  if (typeof req === 'string') return JSON.stringify({ id: null, error: req } satisfies Reply);
  const handler = Object.hasOwn(HANDLERS, req.method) ? HANDLERS[req.method] : undefined;
  if (!handler) return JSON.stringify({ id: req.id, error: `unknown method: ${req.method}` } satisfies Reply);
  try {
    return JSON.stringify({ id: req.id, result: await handler(req.params, deps, live) } satisfies Reply);
  } catch (err) {
    let message = err instanceof Error ? err.message : String(err);
    // Belt and braces: never send a key back, even inside an error.
    const key = (req.params as Record<string, unknown> | undefined)?.apiKey;
    if (typeof key === 'string' && key) message = message.split(key).join('[key hidden]');
    return JSON.stringify({ id: req.id, error: message } satisfies Reply);
  }
}

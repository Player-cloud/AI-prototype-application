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
 *    CI-2: also this computer's ID, every computer's last environment check, version differences
 *    between them, and duplicate or clashing tools in the ledger.
 *  - eval_run: {settings, capability?} -> runs the free repeatable tests (CI-3: planted problems each
 *    tool must find) on test data, saves results in the data folder's evaluations/, counts passes and
 *    failures in tool health, and syncs. Free.
 *  - experiment_run: {settings, capability, runs?} -> CI-5: runs a tool's free test several times in a
 *    row (default 3) and saves the experiment (question, fixed inputs, measures, result) in the data
 *    folder's experiments/ as a proposal. Changes nothing else. Free.
 *  - environment_check: {settings} -> checks this computer (Node, pnpm, git, browser, check tools),
 *    saves it as environments/<computer>.json in the data folder and syncs. Free.
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
 *  - code_folder_create: {settings, slug, path} -> makes a new empty git repo there (branch main, a
 *    README and a .gitignore that keeps keys out, one first commit) when the folder is empty or
 *    missing. Never pushes. Then joshua saves it as the project's code folder.
 *  - code_folder_check: {settings, slug} -> checks the project's code folder on this computer (a git
 *    repo with a commit) and lists its feature runs (worktrees on aip/ branches).
 *  - build_feature: {settings, slug, feature, provider, apiKey, dbPath} -> builds one feature in its own
 *    copy of the code (Sonnet for Claude). Every tool call stays in the copy and goes through the
 *    gatekeeper. Stops at the run's cost limit. Then runs the project's tests, with up to 2 fix
 *    attempts inside the limit. Returns the run, the Using line, steps, tests, sync note and cost,
 *    plus `claims`: what the model's summary claims beside what the app's own checks found (V2 B).
 *    While it runs, event lines {"id", "event"} come first: {type:"using"}, then {type:"step"} each,
 *    and {type:"live"} for the live view of the build's page (V2 A).
 *    A model that fails 3 runs in a row is switched off (D-2) and refused until switched back on.
 *  - run_list: {dbPath, slug?} -> saved feature builds, newest first (waiting, kept or undone, rating).
 *  - workflow_compare: {settings, dbPath} -> CI-4: how each way of building has done in real builds
 *    on this computer (kept, defects, cost in £ and $, time, Undo; joshua's rating kept apart).
 *  - run_keep: {settings, dbPath, id} -> merges a build whose tests pass into joshua's own copy (never
 *    pushes), then removes the build's copy. Refused when his copy has uncommitted changes.
 *  - run_undo: {settings, dbPath, id} -> removes a waiting build's copy and branch.
 *  - run_rate: {dbPath, id, rating, settings?} -> joshua's 1–5 rating for a build.
 *    run_keep, run_undo and run_rate also return `learned`: plain notes when the app added, updated
 *    or dropped a habit in habits.md from the evidence (step 9d). Undoable from History.
 *  - build_feature, run_keep and run_undo also take `githubToken` (optional) and return `phone`: a
 *    plain note on the phone message. A finished build becomes a work item (and, with a token, an
 *    issue on the data repo); Keep or Undo closes both (step 10b).
 *  - work_list: {dbPath} -> open work items for the "Needs you" panel, oldest first.
 *  - work_poll: {settings, dbPath, githubToken} -> reads new replies from joshua's phone on open
 *    items' issues and acts on keep, undo or a 1–5 rating, answering on the issue (step 10c).
 *    Returns {done: plain notes, changed, builds}. Nothing happens without a token.
 *    D: also reads the "start builds from here" issue: "projects", "help", or "build <project> <F-xx>".
 *    A build is checked like the Build button (finished plan, code folder, budget, not `busy`) and
 *    returned in `builds` for the desktop to start; the reply on the issue says the most it can cost.
 *  - phone_setup: {settings, dbPath, githubToken} -> posts the "start builds from here" issue once
 *    (later calls give back the same one).
 *  - github_check: {token, settings} -> {ok, summary}. Free: reads the data repo's issues with the
 *    GitHub token from the password store (step 10a). The token is never put in a reply.
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
import { compareWorkflows } from './workflows.ts';
import { runRepeatExperiment } from './experiments.ts';
import { setupPhone } from './phone.ts';
import type { CheckResult } from '@aip/checks';
import type { Job, ModelAdapter, Provider } from '@aip/models';
import { formatCost } from './money.ts';
import { DEFAULT_SETTINGS, checkSettings, type AppSettings } from './settings.ts';
import { keepRun, listRuns, rateRun, undoRun } from './keep.ts';
import { learnNow } from './learn.ts';
import { githubCheck } from './github.ts';
import { closeBuild, listWork, postBuild, publishPictures } from './notify.ts';
import { pollReplies } from './replies.ts';
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
import { checkCodeFolder, codeFolderOf, createCodeFolder } from './runs.ts';
import { buildFeature } from './build.ts';
import { environmentCheck } from './environment.ts';
import { runFreeTests } from './evals.ts';
import { claimLines } from './claims.ts';

/** D: the build's pictures for its issue, only when the issue will be posted (a token is saved). */
async function picturesFor(settings: AppSettings, slug: string, runId: number, pictures: { name: string; path: string }[], tok: string | undefined) {
  if (!tok || !pictures.length) return {};
  try {
    const r = await publishPictures(settings, slug, runId, pictures);
    return { pictures: r.links, picturesNote: r.note };
  } catch (err) {
    return { picturesNote: `on your PC only: ${(err as Error).message}` };
  }
}

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
  /** Calls to GitHub (step 10); swapped in tests. */
  fetch?: typeof fetch;
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

/** The GitHub token for phone messages, when one is saved (step 10). Never put in a reply. */
function token(p: Record<string, unknown>): string | undefined {
  return typeof p.githubToken === 'string' && p.githubToken !== '' ? p.githubToken : undefined;
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
  eval_run: (params, deps) => {
    const p = obj(params);
    const capability = typeof p.capability === 'string' && p.capability ? p.capability : undefined;
    return runFreeTests(checkSettings(p.settings), { capability, now: deps.now?.() ?? new Date() });
  },
  experiment_run: (params, deps) => {
    const p = obj(params);
    const runs = typeof p.runs === 'number' ? p.runs : undefined;
    const at = deps.now?.();
    return runRepeatExperiment(checkSettings(p.settings), { capability: str(p, 'capability'), runs, now: at ? () => at : undefined });
  },
  environment_check: (params, deps) => environmentCheck(checkSettings(obj(params).settings), deps.now?.() ?? new Date()),
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
    const cost = costText(r.costUsd, settings.gbpPerUsd);
    const dbPath = optionalPath(p, 'dbPath');
    const phone =
      dbPath && r.runId !== null
        ? await postBuild(
            settings,
            dbPath,
            r.runId,
            {
              slug: str(p, 'slug'),
              feature: str(p, 'feature'),
              testsPassed: r.tests.passed,
              fixAttempts: r.tests.fixAttempts,
              blocking: r.keep.blocking,
              advice: r.checks.filter((c) => !c.passed && c.advisory).map((c) => c.name),
              costText: cost,
              screensChanged: r.screensChanged,
              summary: r.summary,
              claims: claimLines(r.claims),
              questions: r.questions,
              ...(await picturesFor(settings, str(p, 'slug'), r.runId, r.pictures, token(p))),
            },
            token(p),
            deps.now?.() ?? new Date(),
            deps.fetch,
          )
        : '';
    return { ...r, modelName: await deps.modelName(r.model), costText: cost, phone };
  },
  code_folder_check: (params) => {
    const p = obj(params);
    const settings = checkSettings(p.settings);
    return checkCodeFolder(codeFolderOf(settings, str(p, 'slug')));
  },
  code_folder_create: async (params) => {
    const p = obj(params);
    const settings = checkSettings(p.settings);
    const slug = str(p, 'slug');
    const name = (await getInterview(settings, slug)).interview.name || slug;
    return createCodeFolder(str(p, 'path').trim(), name);
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
  workflow_compare: (params, deps) => {
    const p = obj(params);
    return compareWorkflows(checkSettings(p.settings), str(p, 'dbPath'), (id) => deps.modelName(id));
  },
  run_list: (params) => {
    const p = obj(params);
    return listRuns(str(p, 'dbPath'), typeof p.slug === 'string' && p.slug ? p.slug : undefined);
  },
  run_keep: async (params, deps) => {
    const p = obj(params);
    const settings = checkSettings(p.settings);
    const now = deps.now?.() ?? new Date();
    const r = await keepRun(settings, str(p, 'dbPath'), runId(p), now);
    const phone = await closeBuild(settings, str(p, 'dbPath'), r.run.id, r.note, token(p), now, deps.fetch);
    return { ...r, phone, learned: await learnNow(settings, str(p, 'dbPath'), (id) => deps.modelName(id), now) };
  },
  run_undo: async (params, deps) => {
    const p = obj(params);
    const settings = checkSettings(p.settings);
    const now = deps.now?.() ?? new Date();
    const r = await undoRun(settings, str(p, 'dbPath'), runId(p), now);
    const phone = await closeBuild(settings, str(p, 'dbPath'), r.run.id, r.note, token(p), now, deps.fetch);
    return { ...r, phone, learned: await learnNow(settings, str(p, 'dbPath'), (id) => deps.modelName(id), now) };
  },
  run_rate: async (params, deps) => {
    const p = obj(params);
    if (typeof p.rating !== 'number') throw new Error('Rating must be a whole number from 1 to 5');
    const run = await rateRun(str(p, 'dbPath'), runId(p), p.rating);
    const settings = checkSettings(p.settings ?? {});
    return { run, learned: await learnNow(settings, str(p, 'dbPath'), (id) => deps.modelName(id), deps.now?.() ?? new Date()) };
  },
  work_list: (params) => listWork(str(obj(params), 'dbPath')),
  work_poll: (params, deps) => {
    const p = obj(params);
    const settings = checkSettings(p.settings);
    const dbPath = str(p, 'dbPath');
    const t = token(p);
    if (!t) return { done: [], changed: false, builds: [] };
    const now = () => deps.now?.() ?? new Date();
    return pollReplies(settings, dbPath, t, now, () => learnNow(settings, dbPath, (id) => deps.modelName(id), now()), deps.fetch, p.busy === true);
  },
  phone_setup: (params, deps) => {
    const p = obj(params);
    const t = token(p);
    if (!t) throw new Error('Add a GitHub token in Settings first: the phone talks to the app through issues on your data repo.');
    return setupPhone(checkSettings(p.settings), str(p, 'dbPath'), t, deps.now?.() ?? new Date(), deps.fetch);
  },
  github_check: (params, deps) => {
    const p = obj(params);
    return githubCheck(str(p, 'token'), checkSettings(p.settings), deps.fetch);
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

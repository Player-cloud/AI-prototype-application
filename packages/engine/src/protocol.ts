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
 *    ask and check also take an optional `settings` (model choices, prices, £/$ rate).
 *    The key comes from the window's password store for this one call and is never echoed back.
 */
import type { Job, ModelAdapter, Provider } from '@aip/models';
import { formatCost } from './money.ts';
import { DEFAULT_SETTINGS, checkSettings, type AppSettings } from './settings.ts';

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
  makeAdapter(provider: Provider, apiKey: string, settings: AppSettings): Promise<ModelAdapter>;
  pickModel(provider: Provider, job: Job, settings: AppSettings): Promise<string>;
  modelName(id: string): Promise<string>;
}

/** Loads the models package only when a model is first used. */
export const realDeps: Deps = {
  async makeAdapter(provider, apiKey, settings) {
    const m = await import('@aip/models');
    if (provider === 'claude') return m.createClaudeAdapter({ apiKey, maxBudgetUsd: 0.5 });
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
  const model = await deps.pickModel(prov, job, settings);
  const adapter = await deps.makeAdapter(prov, apiKey, settings);
  const out = await adapter.run({ job, prompt, model });
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
  const adapter = await deps.makeAdapter(prov, apiKey, settings);
  if (adapter.checkKey) {
    await adapter.checkKey();
    return { ok: true, summary: `Connected. ${PROVIDER_NAME[prov]} accepted the key. This check is free.` };
  }
  const r = await runAsk({ provider: prov, apiKey, settings, job: 'read', prompt: 'Reply with the single word: ready' }, deps);
  return { ok: true, summary: `Connected. ${r.modelName} replied “${r.text.trim()}”. Cost: ${r.costText}.` };
}

type Handler = (params: unknown, deps: Deps) => unknown;

const HANDLERS: Record<string, Handler> = {
  ping: () => ({ ok: true, version: ENGINE_VERSION }),
  ask,
  check,
  settings_check: (params) => checkSettings(obj(params).settings),
};

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
export async function handleLine(line: string, deps: Deps = realDeps): Promise<string> {
  const req = parseRequest(line);
  if (typeof req === 'string') return JSON.stringify({ id: null, error: req } satisfies Reply);
  const handler = Object.hasOwn(HANDLERS, req.method) ? HANDLERS[req.method] : undefined;
  if (!handler) return JSON.stringify({ id: req.id, error: `unknown method: ${req.method}` } satisfies Reply);
  try {
    return JSON.stringify({ id: req.id, result: await handler(req.params, deps) } satisfies Reply);
  } catch (err) {
    let message = err instanceof Error ? err.message : String(err);
    // Belt and braces: never send a key back, even inside an error.
    const key = (req.params as Record<string, unknown> | undefined)?.apiKey;
    if (typeof key === 'string' && key) message = message.split(key).join('[key hidden]');
    return JSON.stringify({ id: req.id, error: message } satisfies Reply);
  }
}

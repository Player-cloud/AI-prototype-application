/**
 * The engine helper talks to the window over stdin/stdout, one JSON object per line.
 * Request:  {"id": 1, "method": "ping"}
 * Reply:    {"id": 1, "result": {...}}  or  {"id": 1, "error": "..."}
 *
 * Methods:
 *  - ping: is the engine up?
 *  - ask:  {provider, apiKey, job, prompt} -> {text, model, modelName, inputTokens, outputTokens, costUsd, costText}
 *    The key comes from the window's password store for this one call and is never echoed back.
 */
import type { Job, ModelAdapter } from '@aip/models';
import { formatCost } from './money.ts';

export const ENGINE_VERSION = '0.0.1';

/** £ per $ used for display until the budget settings arrive (step 4c). */
export const GBP_PER_USD = 0.79;

export interface Request {
  id: number;
  method: string;
  params?: unknown;
}

export type Reply = { id: number | null; result: unknown } | { id: number | null; error: string };

/** What `ask` needs from the models package. Swapped for fakes in tests. */
export interface Deps {
  makeAdapter(provider: string, apiKey: string): Promise<ModelAdapter>;
  pickModel(job: Job): Promise<string>;
  modelName(id: string): Promise<string>;
}

/** Loads the models package only when a model is first used. */
export const realDeps: Deps = {
  async makeAdapter(provider, apiKey) {
    const m = await import('@aip/models');
    if (provider !== 'claude') throw new Error(`provider not available yet: ${provider}`);
    return m.createClaudeAdapter({ apiKey, maxBudgetUsd: 0.5 });
  },
  async pickModel(job) {
    return (await import('@aip/models')).pickClaudeModel(job);
  },
  async modelName(id) {
    return (await import('@aip/models')).modelName(id);
  },
};

const JOBS: readonly Job[] = ['plan', 'final-review', 'security-review', 'build', 'read', 'summarise', 'small-code', 'code-review', 'write-tests', 'plan-review'];

/** "under £0.01 (under $0.01)" for tiny amounts, otherwise "£0.79 ($1.00)". */
export function costText(usd: number, gbpPerUsd = GBP_PER_USD): string {
  return usd * gbpPerUsd < 0.005 ? 'under £0.01 (under $0.01)' : formatCost(usd, gbpPerUsd);
}

function str(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== 'string' || v === '') throw new Error(`${key} is required`);
  return v;
}

async function ask(params: unknown, deps: Deps): Promise<unknown> {
  if (typeof params !== 'object' || params === null) throw new Error('params must be an object');
  const p = params as Record<string, unknown>;
  const provider = str(p, 'provider');
  const apiKey = str(p, 'apiKey');
  const prompt = str(p, 'prompt');
  const job = str(p, 'job') as Job;
  if (!JOBS.includes(job)) throw new Error(`unknown job: ${job}`);
  const model = await deps.pickModel(job);
  const adapter = await deps.makeAdapter(provider, apiKey);
  const out = await adapter.run({ job, prompt, model });
  return {
    text: out.text,
    model,
    modelName: await deps.modelName(model),
    inputTokens: out.usage.inputTokens,
    outputTokens: out.usage.outputTokens,
    costUsd: out.usage.costUsd,
    costText: costText(out.usage.costUsd),
  };
}

type Handler = (params: unknown, deps: Deps) => unknown;

const HANDLERS: Record<string, Handler> = {
  ping: () => ({ ok: true, version: ENGINE_VERSION }),
  ask,
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

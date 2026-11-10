/**
 * OpenAI and DeepSeek share the same "chat completions" API, so one adapter serves both.
 * Plain fetch, no extra packages. Nothing is sent until a key is saved and a job runs.
 */
import type { Job, ModelAdapter, StepResult } from './index.js';
import { redact } from './claude.js';

type OtherProvider = 'openai' | 'deepseek';

export const BASE_URL: Record<OtherProvider, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
};

/**
 * Starting model per job. These are defaults to change in Settings (step 4c), not checked facts:
 * model names change often, and the cloud build machine can't reach the providers' docs.
 */
const STRONG: Record<OtherProvider, string> = { openai: 'gpt-5', deepseek: 'deepseek-reasoner' };
const CHEAP: Record<OtherProvider, string> = { openai: 'gpt-5-mini', deepseek: 'deepseek-chat' };
const STRONG_JOBS: readonly Job[] = ['plan', 'final-review', 'security-review'];
const JOBS: readonly Job[] = ['plan', 'final-review', 'security-review', 'build', 'read', 'summarise', 'small-code', 'code-review', 'write-tests', 'plan-review'];

function table(p: OtherProvider): Record<Job, string> {
  return Object.fromEntries(JOBS.map((j) => [j, STRONG_JOBS.includes(j) ? STRONG[p] : CHEAP[p]])) as Record<Job, string>;
}

export const DEFAULT_MODEL_BY_JOB: Record<OtherProvider, Record<Job, string>> = {
  openai: table('openai'),
  deepseek: table('deepseek'),
};

/** USD per million tokens. */
export interface Price { inputPerM: number; outputPerM: number }

export function costFromPrices(model: string, inputTokens: number, outputTokens: number, prices: Record<string, Price>): number | null {
  const p = prices[model];
  if (!p) return null;
  return (inputTokens * p.inputPerM + outputTokens * p.outputPerM) / 1_000_000;
}

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface OpenAICompatibleOptions {
  provider: OtherProvider;
  apiKey: string;
  /** Prices the user set in Settings; unknown models report cost as unknown. */
  prices?: Record<string, Price>;
  /** Injected in tests; defaults to the built-in fetch. */
  fetch?: FetchFn;
}

const NAME: Record<OtherProvider, string> = { openai: 'OpenAI', deepseek: 'DeepSeek' };

function errorText(provider: OtherProvider, status: number, body: unknown, key: string): string {
  if (status === 401 || status === 403) return `${NAME[provider]} did not accept the API key. Check it in Settings.`;
  if (status === 402) return `Your ${NAME[provider]} account has no credit left.`;
  if (status === 429) return `${NAME[provider]} says too many requests or no quota left. Try again later.`;
  const msg = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return redact(`${NAME[provider]} error ${status}${typeof msg === 'string' ? `: ${msg}` : ''}`, key);
}

export function createOpenAICompatibleAdapter(opts: OpenAICompatibleOptions): ModelAdapter {
  const { provider, apiKey } = opts;
  if (!apiKey) throw new Error(`No ${NAME[provider]} API key saved. Add it in Settings.`);
  const doFetch: FetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchFn);
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  async function call(path: string, method: string, body?: unknown): Promise<unknown> {
    let res;
    try {
      res = await doFetch(`${BASE_URL[provider]}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      throw new Error(redact(`Could not reach ${NAME[provider]}. Check the internet connection. (${m})`, apiKey));
    }
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new Error(errorText(provider, res.status, data, apiKey));
    return data;
  }

  return {
    provider,
    async checkKey() {
      await call('/models', 'GET');
    },
    async run(task): Promise<StepResult> {
      const data = (await call('/chat/completions', 'POST', {
        model: task.model,
        messages: [{ role: 'user', content: task.prompt }],
      })) as {
        choices?: { message?: { content?: unknown } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error(`${NAME[provider]} sent an answer without text.`);
      const inputTokens = data.usage?.prompt_tokens ?? 0;
      const outputTokens = data.usage?.completion_tokens ?? 0;
      return {
        text: redact(content, apiKey),
        usage: { inputTokens, outputTokens, costUsd: costFromPrices(task.model, inputTokens, outputTokens, opts.prices ?? {}) },
      };
    },
  };
}

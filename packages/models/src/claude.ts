/**
 * Claude through the Claude Agent SDK. The SDK is loaded only when the adapter is first used.
 * The API key is passed in per adapter and only ever placed in the SDK's environment.
 *
 * What the build agent gets: the feature's own copy of the code, its own empty home folder, the
 * key saved in Settings, and local git (it can commit in the copy as "AI build").
 * What it does not get: joshua's home folder, ~/.gitconfig, ~/.ssh, saved git logins, or any way
 * to push (the push address is blocked and no login helper runs).
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuildTask, Job, ModelAdapter, StepResult } from './index.js';

/**
 * Only these variables from the PC are passed to Claude. Anything else, in particular other
 * Claude or Anthropic logins, is left out so a run can only ever use the key saved in Settings.
 * The plain ask (no tools) keeps the home variables because it runs nothing. A build does not:
 * `sandboxEnv` swaps them for a throwaway home folder.
 */
const PASS_THROUGH = [
  'PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL',
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
];

/** The environment a Claude run gets: the safe PC variables, its own config folder, and the key. */
export function claudeEnv(apiKey: string, from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASS_THROUGH) {
    const v = from[name];
    if (v !== undefined) env[name] = v;
  }
  // Its own config folder, so it never uses the PC's Claude Code login, settings or history.
  env.CLAUDE_CONFIG_DIR = join(tmpdir(), 'ai-prototype-claude');
  env.ANTHROPIC_API_KEY = apiKey;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'ai-prototype/0.0.1';
  return env;
}

/**
 * The environment for a build run: a copy of `base` where the home folder is the throwaway
 * `sandboxHome`, git has no login and cannot push, and local commits still work.
 * `GIT_CONFIG_COUNT` settings beat the repo's own config, so the copy's remote can't re-enable push.
 */
export function sandboxEnv(base: Record<string, string>, sandboxHome: string, opts: { pnpmStore?: string } = {}): Record<string, string> {
  const env: Record<string, string> = { ...base };
  delete env.HOMEDRIVE;
  delete env.HOMEPATH;
  env.HOME = sandboxHome;
  env.USERPROFILE = sandboxHome;
  env.APPDATA = join(sandboxHome, 'AppData', 'Roaming');
  env.LOCALAPPDATA = join(sandboxHome, 'AppData', 'Local');
  env.XDG_CONFIG_HOME = join(sandboxHome, '.config');
  env.XDG_DATA_HOME = join(sandboxHome, '.local', 'share');
  env.XDG_CACHE_HOME = join(sandboxHome, '.cache');
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = join(sandboxHome, '.gitconfig');
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  const overrides: [string, string][] = [
    ['credential.helper', ''],
    ['remote.origin.pushurl', 'blocked://the-build-copy-cannot-push'],
    ['remote.pushDefault', 'blocked'],
  ];
  env.GIT_CONFIG_COUNT = String(overrides.length);
  overrides.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  env.GIT_AUTHOR_NAME = 'AI build';
  env.GIT_AUTHOR_EMAIL = 'ai-build@localhost';
  env.GIT_COMMITTER_NAME = 'AI build';
  env.GIT_COMMITTER_EMAIL = 'ai-build@localhost';
  if (opts.pnpmStore) env.npm_config_store_dir = opts.pnpmStore;
  env.npm_config_cache = join(sandboxHome, '.npm-cache');
  return env;
}

/** The parts of an Agent SDK message this adapter reads. */
export interface SdkMessage {
  type: string;
  subtype?: string;
  result?: string;
  errors?: string[];
  total_cost_usd?: number;
  /** For assistant messages: the content blocks, including tool calls. */
  message?: { content?: Array<{ type: string; name?: string; input?: Record<string, unknown>; text?: string }> };
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>;
}

export type QueryFn = (params: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<SdkMessage>;

export interface ClaudeAdapterOptions {
  apiKey: string;
  /** Stop a single run if it would cost more than this (USD). */
  maxBudgetUsd?: number;
  /** Injected in tests; defaults to the real SDK's query(). */
  query?: QueryFn;
}

async function loadQuery(): Promise<QueryFn> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return sdk.query as unknown as QueryFn;
}

/** Replaces the key anywhere it might appear in a message, so it can never leak into an error. */
export function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join('[key hidden]') : text;
}

export function friendlyError(raw: string): string {
  const t = raw.toLowerCase();
  if (t.includes('401') || t.includes('invalid x-api-key') || t.includes('invalid api key') || t.includes('authentication')) {
    return 'Claude did not accept the API key. Check it in Settings.';
  }
  if (t.includes('credit balance') || t.includes('billing')) return 'Your Anthropic account has no credit left.';
  if (t.includes('max_budget') || t.includes('budget')) return 'Stopped: this run would have gone over its cost limit.';
  if (t.includes('enotfound') || t.includes('econnrefused') || t.includes('network')) return 'Could not reach Claude. Check the internet connection.';
  return raw;
}

/** The only tools a build may use: read, search, edit files and run commands, all in its own copy. */
export const BUILD_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] as const;

/** Most turns one build may take. */
const BUILD_TURNS = 60;

/** One tool call in plain words for the step list, e.g. "Edit src/app/page.tsx". */
export function stepText(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const short = (t: string) => (t.length > 80 ? `${t.slice(0, 77)}…` : t);
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return `${name} ${s('file_path')}`;
    case 'Glob':
    case 'Grep':
      return `Search ${short(s('pattern'))}`;
    case 'Bash':
      return `Run ${short(s('command').replace(/\s+/g, ' '))}`;
    default:
      return name;
  }
}

function usageOf(final: SdkMessage, apiKey: string): StepResult {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const u of Object.values(final.modelUsage ?? {})) {
    inputTokens += u.inputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
    outputTokens += u.outputTokens;
  }
  return { text: redact(final.result ?? '', apiKey), usage: { inputTokens, outputTokens, costUsd: final.total_cost_usd ?? 0 } };
}

export function createClaudeAdapter(opts: ClaudeAdapterOptions): ModelAdapter {
  if (!opts.apiKey) throw new Error('No Claude API key saved. Add it in Settings.');
  return {
    provider: 'claude',
    async run(task: { job: Job; prompt: string; model: string }): Promise<StepResult> {
      const query = opts.query ?? (await loadQuery());
      let final: SdkMessage | undefined;
      try {
        for await (const msg of query({
          prompt: task.prompt,
          options: {
            model: task.model,
            env: claudeEnv(opts.apiKey), // replaces the child's environment entirely
            settingSources: [], // don't read the PC's own Claude settings
            tools: [], // plain question and answer; tools load only when a job picks them
            maxTurns: 1,
            persistSession: false,
            ...(opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
          },
        })) {
          if (msg.type === 'result') final = msg;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(friendlyError(redact(message, opts.apiKey)));
      }
      if (!final) throw new Error('Claude ended without an answer.');
      if (final.subtype !== 'success') {
        const why = (final.errors ?? []).join('; ') || final.subtype || 'unknown error';
        throw new Error(friendlyError(redact(why, opts.apiKey)));
      }
      return usageOf(final, opts.apiKey);
    },
    async build(task: BuildTask): Promise<StepResult> {
      const query = opts.query ?? (await loadQuery());
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      task.signal?.addEventListener('abort', onAbort);
      let final: SdkMessage | undefined;
      try {
        for await (const msg of query({
          prompt: task.prompt,
          options: {
            model: task.model,
            cwd: task.cwd,
            env: task.sandbox ? sandboxEnv(claudeEnv(opts.apiKey), task.sandbox.home, { pnpmStore: task.sandbox.pnpmStore }) : claudeEnv(opts.apiKey),
            settingSources: [], // never the PC's or the project's own Claude settings
            tools: [...BUILD_TOOLS],
            permissionMode: 'default', // every tool call comes to checkTool first
            canUseTool: async (name: string, input: Record<string, unknown>) => {
              const d = await task.checkTool(name, input);
              return d.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: d.reason };
            },
            maxTurns: BUILD_TURNS,
            persistSession: false,
            abortController: abort,
            ...(opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
          },
        })) {
          if (msg.type === 'assistant') {
            for (const b of msg.message?.content ?? []) if (b.type === 'tool_use' && b.name) task.onStep?.(stepText(b.name, b.input ?? {}));
          }
          if (msg.type === 'result') final = msg;
        }
      } catch (err) {
        if (task.signal?.aborted) throw new Error('Stopped.');
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(friendlyError(redact(message, opts.apiKey)));
      } finally {
        task.signal?.removeEventListener('abort', onAbort);
      }
      if (!final) throw new Error(task.signal?.aborted ? 'Stopped.' : 'Claude ended without an answer.');
      if (final.subtype !== 'success') {
        const why = (final.errors ?? []).join('; ') || final.subtype || 'unknown error';
        throw new Error(friendlyError(redact(why, opts.apiKey)));
      }
      return usageOf(final, opts.apiKey);
    },
  };
}

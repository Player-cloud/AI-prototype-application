/**
 * Stage 1 of the SDK-free plan: Claude through the plain Messages API, with the app's own build loop.
 * No Agent SDK, no extra packages (plain fetch, like the OpenAI adapter). The model gets six tools
 * (Read, Glob, Grep, Edit, Write, Bash) with the same names and inputs as the SDK's, so the same
 * `checkTool` gate sees every call first. Files stay inside the feature's own copy, the shell runs
 * with the throwaway home from `sandboxEnv` and never sees the API key, and a turn limit, a cost
 * limit and the stop signal end a run. Off by default (Settings: ownBuildLoop); the SDK adapter stays.
 */
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BuildTask, Job, ModelAdapter, StepResult } from './index.js';
import { claudeEnv, friendlyError, redact, sandboxEnv, stepText } from './claude.js';
import type { FetchFn, Price } from './openai-compatible.js';

const API = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MAX_TURNS = 60;
const MAX_TOKENS = 16000;
const TOOL_OUTPUT_MAX = 30_000;
const READ_LINES = 2000;
const SHELL_DEFAULT_MS = 120_000;
const SHELL_MAX_MS = 600_000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'target']);

export interface ClaudeLoopOptions {
  apiKey: string;
  /** Stop a run when its cost would pass this (USD). Needs a price for the model. */
  maxBudgetUsd?: number;
  /** $ per million tokens by model id (Settings). A build needs the price of its model. */
  prices?: Record<string, Price>;
  /** Injected in tests; defaults to the built-in fetch. */
  fetch?: FetchFn;
  /** Injected in tests: waits before a retry. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests: runs a shell command. */
  runShell?: ShellFn;
  maxTurns?: number;
}

export type ShellFn = (command: string, opts: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal }) => Promise<{ code: number | null; output: string }>;

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  cache_control?: { type: 'ephemeral' };
}
interface Message { role: 'user' | 'assistant'; content: Block[] }
interface ApiReply {
  content?: Block[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  error?: { message?: string };
}

const TOOLS = [
  { name: 'Read', description: 'Read a file in the project. Returns numbered lines.', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'integer', description: 'First line, from 1' }, limit: { type: 'integer', description: 'Lines to read' } }, required: ['file_path'] } },
  { name: 'Glob', description: 'List files by a pattern like src/**/*.ts.', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Folder to search, default the project' } }, required: ['pattern'] } },
  { name: 'Grep', description: 'Search file contents with a regular expression.', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  { name: 'Edit', description: 'Replace text in a file. old_string must appear exactly once unless replace_all is true.', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['file_path', 'old_string', 'new_string'] } },
  { name: 'Write', description: 'Create or replace a file with the given content.', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
  { name: 'Bash', description: 'Run a shell command in the project folder. Output is cut if long.', input_schema: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'integer', description: 'Milliseconds, default 120000' } }, required: ['command'] } },
];

const SYSTEM = 'You are a careful software engineer working in one project folder. Use the tools to read, search, edit and run commands there. Keep changes small and focused, run the tests, and finish with a short plain summary of what you did and what you could not do.';

/** The key never leaves the process: the shell gets the safe PC variables, not ANTHROPIC_API_KEY. */
function shellBase(): Record<string, string> {
  const env = claudeEnv('');
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_AGENT_SDK_CLIENT_APP;
  return env;
}

/** The cost of one reply. Cached reads are 1/10 and cache writes 1.25x the input price. */
export function replyCostUsd(model: string, u: NonNullable<ApiReply['usage']>, prices: Record<string, Price>): number | null {
  const p = prices[model];
  if (!p) return null;
  const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) * 0.1 + (u.cache_creation_input_tokens ?? 0) * 1.25;
  return (input * p.inputPerM + (u.output_tokens ?? 0) * p.outputPerM) / 1_000_000;
}

/** Resolves a path the model gave inside `root`, following links. Throws a plain reason when it is outside. */
export async function insideRoot(root: string, given: string): Promise<string> {
  const realRoot = await realpath(root);
  const abs = isAbsolute(given) ? resolve(given) : resolve(realRoot, given);
  // The deepest part that exists is resolved through links; the rest is not there yet.
  let existing = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) throw new Error('That path is not valid.');
      rest.unshift(existing.slice(parent.length + 1));
      existing = parent;
    }
  }
  const full = join(existing, ...rest);
  const rel = relative(realRoot, full);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('That path is outside the project copy, so it was refused.');
  return full;
}

function clip(text: string): string {
  if (text.length <= TOOL_OUTPUT_MAX) return text;
  const half = Math.floor(TOOL_OUTPUT_MAX / 2);
  return `${text.slice(0, half)}\n…[${text.length - TOOL_OUTPUT_MAX} characters left out]…\n${text.slice(-half)}`;
}

async function* walk(dir: string, root: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(p, root);
    } else if (e.isFile()) yield relative(root, p).split(sep).join('/');
  }
}

/** A small glob: ** crosses folders, * and ? stay inside one. */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const defaultShell: ShellFn = (command, { cwd, env, timeoutMs, signal }) =>
  new Promise((resolveRun, reject) => {
    const child = spawn('bash', ['-c', command], { cwd, env, detached: process.platform !== 'win32', windowsHide: true });
    let output = '';
    const add = (b: Buffer) => {
      if (output.length < TOOL_OUTPUT_MAX * 4) output += b.toString();
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const kill = () => {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      output += '\n[stopped: the command ran too long]';
      kill();
    }, timeoutMs);
    const onAbort = () => kill();
    signal?.addEventListener('abort', onAbort);
    child.on('error', (e) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Could not start the shell (bash): ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolveRun({ code, output });
    });
  });

export function createClaudeLoopAdapter(opts: ClaudeLoopOptions): ModelAdapter {
  const { apiKey } = opts;
  if (!apiKey) throw new Error('No Claude API key saved. Add it in Settings.');
  const doFetch: FetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchFn);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const prices = opts.prices ?? {};
  const headers = { 'x-api-key': apiKey, 'anthropic-version': API_VERSION, 'content-type': 'application/json' };

  async function post(body: unknown, signal?: AbortSignal): Promise<ApiReply> {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await doFetch(API, { method: 'POST', headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) } as Parameters<FetchFn>[1]);
      } catch (err) {
        if (signal?.aborted) throw new Error('Stopped.');
        const m = err instanceof Error ? err.message : String(err);
        throw new Error(friendlyError(redact(`Could not reach Claude. Check the internet connection. (${m})`, apiKey)));
      }
      const data = (await res.json().catch(() => null)) as ApiReply | null;
      if (res.ok && data) return data;
      if ([429, 500, 502, 503, 529].includes(res.status) && attempt < 2) {
        await sleep(attempt === 0 ? 1000 : 3000);
        continue;
      }
      const msg = data?.error?.message ?? '';
      if (res.status === 401 || res.status === 403) throw new Error('Claude did not accept the API key. Check it in Settings.');
      throw new Error(friendlyError(redact(`Claude error ${res.status}${msg ? `: ${msg}` : ''}`, apiKey)));
    }
  }

  const textOf = (blocks: Block[] | undefined) => (blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();

  return {
    provider: 'claude',
    async checkKey() {
      await post({ model: 'claude-haiku-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
    },
    async run(task: { job: Job; prompt: string; model: string }): Promise<StepResult> {
      const data = await post({ model: task.model, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: task.prompt }] });
      const u = data.usage ?? {};
      return {
        text: redact(textOf(data.content), apiKey),
        usage: {
          inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
          costUsd: replyCostUsd(task.model, u, prices),
        },
      };
    },
    async build(task: BuildTask): Promise<StepResult> {
      // Fail closed: without a price the cost limit could not work, so nothing is spent.
      if (!prices[task.model]) throw new Error(`Set the price for ${task.model} in Settings → Budget and models first, so the cost limit can work for the app's own build loop.`);
      const runShell = opts.runShell ?? defaultShell;
      const env = task.sandbox ? sandboxEnv(shellBase(), task.sandbox.home, { pnpmStore: task.sandbox.pnpmStore }) : shellBase();
      const maxTurns = opts.maxTurns ?? MAX_TURNS;
      const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: task.prompt }] }];
      let inputTokens = 0;
      let outputTokens = 0;
      let costUsd = 0;

      const stopped = () => task.signal?.aborted === true;

      async function runTool(name: string, input: Record<string, unknown>): Promise<{ text: string; error?: boolean }> {
        const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
        try {
          switch (name) {
            case 'Read': {
              const p = await insideRoot(task.cwd, str('file_path'));
              const lines = (await readFile(p, 'utf8')).split('\n');
              if (lines.length > 1 && lines.at(-1) === '') lines.pop();
              const from = Math.max(1, Number(input.offset) || 1);
              const n = Math.min(READ_LINES, Number(input.limit) || READ_LINES);
              return { text: clip(lines.slice(from - 1, from - 1 + n).map((l, i) => `${from + i}\t${l}`).join('\n')) };
            }
            case 'Glob': {
              const base = await insideRoot(task.cwd, str('path') || '.');
              const re = globToRegExp(str('pattern'));
              const out: string[] = [];
              for await (const f of walk(base, base)) if (re.test(f)) out.push(f);
              return { text: out.length ? clip(out.slice(0, 500).join('\n')) : 'No files matched.' };
            }
            case 'Grep': {
              const base = await insideRoot(task.cwd, str('path') || '.');
              let re: RegExp;
              try {
                re = new RegExp(str('pattern'));
              } catch {
                return { text: 'That is not a valid regular expression.', error: true };
              }
              const hits: string[] = [];
              for await (const f of walk(base, base)) {
                if (hits.length >= 200) break;
                const full = join(base, f);
                if ((await stat(full)).size > 1_000_000) continue;
                const text = await readFile(full, 'utf8');
                if (text.includes('\u0000')) continue;
                text.split('\n').forEach((l, i) => {
                  if (hits.length < 200 && re.test(l)) hits.push(`${f}:${i + 1}:${l.slice(0, 300)}`);
                });
              }
              return { text: hits.length ? clip(hits.join('\n')) : 'No matches.' };
            }
            case 'Edit': {
              const p = await insideRoot(task.cwd, str('file_path'));
              const before = await readFile(p, 'utf8');
              const oldS = str('old_string');
              if (!oldS) return { text: 'old_string is empty.', error: true };
              const count = before.split(oldS).length - 1;
              if (count === 0) return { text: 'old_string was not found in the file.', error: true };
              if (count > 1 && input.replace_all !== true) return { text: `old_string appears ${count} times. Add more around it, or set replace_all.`, error: true };
              await writeFile(p, before.split(oldS).join(str('new_string')));
              return { text: `Edited ${str('file_path')}.` };
            }
            case 'Write': {
              const p = await insideRoot(task.cwd, str('file_path'));
              await mkdir(dirname(p), { recursive: true });
              await writeFile(p, str('content'));
              return { text: `Wrote ${str('file_path')}.` };
            }
            case 'Bash': {
              const timeoutMs = Math.min(SHELL_MAX_MS, Math.max(1000, Number(input.timeout) || SHELL_DEFAULT_MS));
              const r = await runShell(str('command'), { cwd: task.cwd, env, timeoutMs, ...(task.signal ? { signal: task.signal } : {}) });
              return { text: clip(`${r.output}${r.code === 0 ? '' : `\n[exit code ${r.code}]`}`.trim() || '(no output)'), error: r.code !== 0 };
            }
            default:
              return { text: `There is no tool called ${name}.`, error: true };
          }
        } catch (err) {
          return { text: redact(err instanceof Error ? err.message : String(err), apiKey), error: true };
        }
      }

      for (let turn = 0; turn < maxTurns; turn++) {
        if (stopped()) throw new Error('Stopped.');
        // Two cache breakpoints: the system text (with the tools before it) and the newest message.
        const body = {
          model: task.model,
          max_tokens: MAX_TOKENS,
          system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
          tools: TOOLS,
          messages: messages.map((m, i) => (i === messages.length - 1 ? { ...m, content: m.content.map((b, j) => (j === m.content.length - 1 ? { ...b, cache_control: { type: 'ephemeral' } } : b)) } : m)),
        };
        const reply = await post(body, task.signal);
        const u = reply.usage ?? {};
        inputTokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        outputTokens += u.output_tokens ?? 0;
        costUsd += replyCostUsd(task.model, u, prices) ?? 0;
        const content = reply.content ?? [];
        messages.push({ role: 'assistant', content });
        const calls = content.filter((b) => b.type === 'tool_use');
        if (calls.length === 0) {
          if (reply.stop_reason === 'max_tokens') throw new Error('Claude ended without an answer: it ran out of room before finishing.');
          return { text: redact(textOf(content), apiKey), usage: { inputTokens, outputTokens, costUsd } };
        }
        if (opts.maxBudgetUsd !== undefined && costUsd > opts.maxBudgetUsd) throw new Error('Stopped: this run would have gone over its cost limit.');
        const results: Block[] = [];
        for (const call of calls) {
          const name = call.name ?? '';
          const input = call.input ?? {};
          if (stopped()) throw new Error('Stopped.');
          task.onStep?.(stepText(name, input));
          // Every call is checked first; a refusal goes back to the model as the tool's answer.
          const d = await task.checkTool(name, input);
          const r = d.allow ? await runTool(name, input) : { text: d.reason, error: true };
          results.push({ type: 'tool_result', tool_use_id: call.id ?? '', content: redact(r.text, apiKey), ...(r.error ? { is_error: true } : {}) });
        }
        messages.push({ role: 'user', content: results });
      }
      throw new Error(`Stopped: the build ran out of turns without finishing (max turns: ${maxTurns}).`);
    },
  };
}

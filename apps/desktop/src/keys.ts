import type { Invoke } from './engine';

/** Model providers, plus 'github': the token for phone messages (step 10). */
export type Provider = 'anthropic' | 'openai' | 'deepseek' | 'github';

export const PROVIDERS: readonly { id: Provider; name: string; hint: string }[] = [
  { id: 'anthropic', name: 'Claude (Anthropic)', hint: 'Starts with sk-ant-' },
  { id: 'openai', name: 'OpenAI', hint: 'Starts with sk-' },
  { id: 'deepseek', name: 'DeepSeek', hint: 'Starts with sk-' },
  { id: 'github', name: 'GitHub (phone messages)', hint: 'Fine-grained token, starts with github_pat_' },
];

/** What the Rust shell says about a key. The key itself never comes back. */
export interface KeyStatus {
  provider: Provider;
  saved: boolean;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function keyStatus(invoke: Invoke, provider: Provider): Promise<KeyStatus> {
  return invoke<KeyStatus>('key_status', { provider });
}

export async function saveKey(invoke: Invoke, provider: Provider, key: string): Promise<KeyStatus> {
  try {
    return await invoke<KeyStatus>('key_save', { provider, key });
  } catch (err) {
    throw new Error(message(err));
  }
}

export async function removeKey(invoke: Invoke, provider: Provider): Promise<KeyStatus> {
  try {
    return await invoke<KeyStatus>('key_remove', { provider });
  } catch (err) {
    throw new Error(message(err));
  }
}

/** What "Test connection" returns. Never contains the key. */
export interface TestResult {
  ok: boolean;
  summary: string;
}

/**
 * Claude does a one-word ask (tiny cost); OpenAI and DeepSeek use their free "list models" check.
 * GitHub reads the data repo's issues (free).
 */
export async function testModel(invoke: Invoke, provider: Provider): Promise<TestResult> {
  try {
    return provider === 'github' ? await invoke<TestResult>('github_test') : await invoke<TestResult>('test_model', { provider });
  } catch (err) {
    throw new Error(message(err));
  }
}

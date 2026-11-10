import type { Invoke } from './engine';

export type Provider = 'anthropic' | 'openai' | 'deepseek';

export const PROVIDERS: readonly { id: Provider; name: string; hint: string }[] = [
  { id: 'anthropic', name: 'Claude (Anthropic)', hint: 'Starts with sk-ant-' },
  { id: 'openai', name: 'OpenAI', hint: 'Starts with sk-' },
  { id: 'deepseek', name: 'DeepSeek', hint: 'Starts with sk-' },
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

/** What a test call returns. Never contains the key. */
export interface TestResult {
  text: string;
  modelName: string;
  costText: string;
}

/** Providers the engine can already call (the others arrive in step 4b). */
export const CALLABLE: readonly Provider[] = ['anthropic'];

export async function testModel(invoke: Invoke, provider: Provider): Promise<TestResult> {
  try {
    return await invoke<TestResult>('test_model', { provider });
  } catch (err) {
    throw new Error(message(err));
  }
}

export function testSummary(r: TestResult): string {
  const said = r.text.trim().slice(0, 80);
  return `Connected. ${r.modelName} replied “${said}”. Cost: ${r.costText}.`;
}

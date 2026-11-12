export type EngineStatus = { state: 'running'; version: string } | { state: 'stopped'; reason: string };

/** Calls into the Rust shell. Injected so screens can be tested without Tauri. */
export type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * The one way to call an engine method through the shell. The Rust side only runs methods on its
 * allow-list, and always adds the saved settings itself (anything sent as `settings` is replaced).
 */
export function engine<T>(invoke: Invoke, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>('engine', { method, params });
}

export function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function getEngineStatus(invoke: Invoke | null): Promise<EngineStatus> {
  if (!invoke) return { state: 'stopped', reason: 'browser preview (no window shell)' };
  try {
    return await invoke<EngineStatus>('engine_status');
  } catch (err) {
    return { state: 'stopped', reason: err instanceof Error ? err.message : String(err) };
  }
}

export function engineLabel(status: EngineStatus | null): string {
  if (!status) return 'Engine: checking…';
  return status.state === 'running' ? `Engine: running (v${status.version})` : 'Engine: not running';
}

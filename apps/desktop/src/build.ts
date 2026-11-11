import type { Invoke } from './engine';

/** Makes a Tauri Channel that calls `onMessage` for each value Rust sends. Injected for tests. */
export type MakeChannel = <T>(onMessage: (message: T) => void) => unknown;

export interface RunInfo { path: string; branch: string; feature: string; base: string }
export interface BuildStep { text: string; refused?: string }
export type BuildEvent = { type: 'using'; using: string; run: RunInfo } | ({ type: 'step' } & BuildStep);

export interface BuildResult {
  run: RunInfo;
  using: string;
  steps: BuildStep[];
  summary: string;
  modelName: string;
  costText: string;
  /** The project's tests after the build and any fix attempts. */
  tests: { passed: boolean; output: string; fixAttempts: number };
  /** How the data folder sync went ('' with no data folder). */
  synced: string;
}

const plain = (err: unknown) => new Error(err instanceof Error ? err.message : String(err));

/** Builds one feature; each step arrives through `onEvent` while it runs. Costs money. */
export async function startBuild(
  invoke: Invoke,
  makeChannel: MakeChannel,
  slug: string,
  feature: string,
  onEvent: (e: BuildEvent) => void,
): Promise<BuildResult> {
  try {
    return await invoke<BuildResult>('build_feature', { slug, feature, onStep: makeChannel<BuildEvent>(onEvent) });
  } catch (err) {
    throw plain(err);
  }
}

/** Stops the running build. False if none was running. */
export async function stopBuild(invoke: Invoke): Promise<boolean> {
  try {
    return await invoke<boolean>('build_stop');
  } catch (err) {
    throw plain(err);
  }
}

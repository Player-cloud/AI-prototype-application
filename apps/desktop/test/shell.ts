import type { Invoke } from '../src/engine';

/**
 * Test fakes answer by method name. The app now sends engine methods as one `engine` command
 * ({ method, params }); this unpacks that so a fake sees `method` and `params` as its command and
 * arguments. Every other command goes through untouched.
 */
export function routeEngine(fake: Invoke): Invoke {
  return (<T,>(cmd: string, args?: Record<string, unknown>) =>
    cmd === 'engine' ? fake<T>(String(args?.method), (args?.params ?? {}) as Record<string, unknown>) : fake<T>(cmd, args)) as Invoke;
}

/**
 * The engine helper talks to the window over stdin/stdout, one JSON object per line.
 * Request:  {"id": 1, "method": "ping"}
 * Reply:    {"id": 1, "result": {...}}  or  {"id": 1, "error": "..."}
 */

export const ENGINE_VERSION = '0.0.1';

export interface Request {
  id: number;
  method: string;
  params?: unknown;
}

export type Reply = { id: number | null; result: unknown } | { id: number | null; error: string };

type Handler = (params: unknown) => unknown;

const HANDLERS: Record<string, Handler> = {
  ping: () => ({ ok: true, version: ENGINE_VERSION }),
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

/** Turns one line of input into one line of output. Never throws. */
export function handleLine(line: string): string {
  const req = parseRequest(line);
  if (typeof req === 'string') return JSON.stringify({ id: null, error: req } satisfies Reply);
  const handler = Object.hasOwn(HANDLERS, req.method) ? HANDLERS[req.method] : undefined;
  if (!handler) return JSON.stringify({ id: req.id, error: `unknown method: ${req.method}` } satisfies Reply);
  try {
    return JSON.stringify({ id: req.id, result: handler(req.params) } satisfies Reply);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ id: req.id, error: message } satisfies Reply);
  }
}

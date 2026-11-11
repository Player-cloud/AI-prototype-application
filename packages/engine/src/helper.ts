/**
 * Entry point the desktop window starts as a separate program.
 * Reads one JSON request per line on stdin and writes one reply per line on stdout.
 * Requests are answered in order. A long request may first send event lines ({"id", "event"}).
 * "cancel" is answered at once, out of turn, and stops the request it names.
 * Exits when stdin closes (the window closed).
 */
import { createInterface } from 'node:readline';
import { handleLine } from './protocol.ts';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const running = new Map<number, AbortController>();
let queue = Promise.resolve();

const write = (v: unknown) => process.stdout.write(`${typeof v === 'string' ? v : JSON.stringify(v)}\n`);

/** {"id": n, "method": "cancel", "params": {"id": m}} -> stops request m, if it's waiting or running. */
function cancelOf(line: string): { id: number; target: number } | null {
  try {
    const v = JSON.parse(line) as { id?: unknown; method?: unknown; params?: { id?: unknown } };
    if (v.method !== 'cancel' || typeof v.id !== 'number' || typeof v.params?.id !== 'number') return null;
    return { id: v.id, target: v.params.id };
  } catch {
    return null;
  }
}

function idOf(line: string): number | null {
  try {
    const id = (JSON.parse(line) as { id?: unknown }).id;
    return typeof id === 'number' ? id : null;
  } catch {
    return null;
  }
}

lines.on('line', (line) => {
  if (line.trim() === '') return;
  const cancel = cancelOf(line);
  if (cancel) {
    const c = running.get(cancel.target);
    c?.abort();
    write({ id: cancel.id, result: { cancelled: c !== undefined } });
    return;
  }
  const id = idOf(line);
  const stop = new AbortController();
  if (id !== null) running.set(id, stop);
  queue = queue.then(async () => {
    const emit = (event: unknown) => write({ id, event });
    write(await handleLine(line, undefined, { emit, signal: stop.signal }));
    if (id !== null) running.delete(id);
  });
});
lines.on('close', () => {
  void queue.then(() => process.exit(0));
});

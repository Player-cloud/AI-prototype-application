/**
 * Entry point the desktop window starts as a separate program.
 * Reads one JSON request per line on stdin and writes one reply per line on stdout.
 * Requests are answered in order. Exits when stdin closes (the window closed).
 */
import { createInterface } from 'node:readline';
import { handleLine } from './protocol.ts';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();

lines.on('line', (line) => {
  if (line.trim() === '') return;
  queue = queue.then(async () => {
    process.stdout.write((await handleLine(line)) + '\n');
  });
});
lines.on('close', () => {
  void queue.then(() => process.exit(0));
});

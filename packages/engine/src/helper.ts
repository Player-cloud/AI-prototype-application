/**
 * Entry point the desktop window starts as a separate program.
 * Reads one JSON request per line on stdin and writes one reply per line on stdout.
 * Exits when stdin closes (the window closed).
 */
import { createInterface } from 'node:readline';
import { handleLine } from './protocol.ts';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (line.trim() === '') return;
  process.stdout.write(handleLine(line) + '\n');
});
lines.on('close', () => process.exit(0));

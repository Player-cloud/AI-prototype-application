import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ENGINE_VERSION, handleLine } from '../src/protocol.ts';

describe('handleLine', () => {
  it('answers ping with the engine version', async () => {
    expect(JSON.parse(await handleLine('{"id":1,"method":"ping"}'))).toEqual({
      id: 1,
      result: { ok: true, version: ENGINE_VERSION },
    });
  });

  it('reports an unknown method without throwing', async () => {
    expect(JSON.parse(await handleLine('{"id":2,"method":"nope"}'))).toEqual({ id: 2, error: 'unknown method: nope' });
  });

  it('does not treat built-in object names as methods', async () => {
    expect(JSON.parse(await handleLine('{"id":3,"method":"toString"}'))).toEqual({
      id: 3,
      error: 'unknown method: toString',
    });
  });

  it('rejects bad input with id null', async () => {
    expect(JSON.parse(await handleLine('not json'))).toEqual({ id: null, error: 'bad JSON' });
    expect(JSON.parse(await handleLine('[]'))).toEqual({ id: null, error: 'id must be a whole number' });
    expect(JSON.parse(await handleLine('{"id":1.5,"method":"ping"}'))).toEqual({ id: null, error: 'id must be a whole number' });
    expect(JSON.parse(await handleLine('{"id":1}'))).toEqual({ id: null, error: 'method must be a string' });
  });
});

describe('helper program', () => {
  it('answers over stdin/stdout and exits when stdin closes', async () => {
    const helper = fileURLToPath(new URL('../src/helper.ts', import.meta.url));
    // Node 22.6+ runs .ts files directly with this flag; the app runs the built .js.
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', helper]);
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stdin.write('{"id":7,"method":"ping"}\n');
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(0);
    expect(JSON.parse(out.trim())).toEqual({ id: 7, result: { ok: true, version: ENGINE_VERSION } });
  });
});

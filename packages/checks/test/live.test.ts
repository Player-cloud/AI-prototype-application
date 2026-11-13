import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { watchLive, type LivePreview, type LiveState } from '../src/index.ts';

/** Waits until the live view says something that matches. */
async function until(states: LiveState[], match: (s: LiveState) => boolean, ms = 15_000): Promise<LiveState> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = states.find(match);
    if (s) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`never said that; it said: ${states.map((s) => s.note).join(' / ')}`);
}

const reachable = (url: string) =>
  fetch(url).then(
    (r) => r.ok,
    () => false,
  );

describe('live view of a build', () => {
  let dir = '';
  let live: LivePreview | null = null;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'aip-live-')));
  });
  afterEach(async () => {
    await live?.stop();
    live = null;
    await rm(dir, { recursive: true, force: true });
  });

  it('waits for a page, shows a plain page once the build makes one, and closes it on stop', async () => {
    const states: LiveState[] = [];
    live = watchLive(dir, (s) => states.push(s), { pollMs: 50 });
    await until(states, (s) => s.note.startsWith('Waiting for the build to make a page'));
    await writeFile(join(dir, 'index.html'), '<h1>Club HR</h1>');
    const shown = await until(states, (s) => s.url !== null);
    expect(shown).toMatchObject({ reloads: true, note: 'Live: the build’s own copy, updating as it changes.' });
    expect(shown.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(await (await fetch(shown.url!)).text()).toBe('<h1>Club HR</h1>');
    await live.stop();
    expect(await reachable(shown.url!)).toBe(false);
    const said = states.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(states.length).toBe(said); // nothing more after stop
  });

  it('waits for packages before starting a Next.js or Vite page', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '16' } }));
    const states: LiveState[] = [];
    live = watchLive(dir, (s) => states.push(s), { pollMs: 50 });
    await until(states, (s) => s.note === 'Waiting for the build to install its packages.');
  });

  it('starts the page server again when it stops, then gives up after a few starts', async () => {
    // A page server that answers once and then quits, standing in for next dev.
    await writeFile(
      join(dir, 'server.cjs'),
      "const http=require('http');const s=http.createServer((q,r)=>{r.end('hi');setTimeout(()=>process.exit(0),20)});s.listen(Number(process.argv[2]),'127.0.0.1');",
    );
    const states: LiveState[] = [];
    live = watchLive(dir, (s) => states.push(s), {
      pollMs: 50,
      maxStarts: 2,
      command: async () => ({ cmd: process.execPath, args: ['server.cjs'] }),
    });
    const first = await until(states, (s) => s.url !== null);
    expect(first.reloads).toBe(false); // Next.js and Vite update the page themselves
    await until(states, (s) => s.note === 'The page stopped. The app will start it again.');
    await until(states, (s) => s.note.startsWith('The live view stopped trying after 2 starts'));
    expect(states.filter((s) => s.url !== null)).toHaveLength(2);
  });

  it('says why a page didn’t start, and tries again', async () => {
    await mkdir(join(dir, 'node_modules'));
    await writeFile(join(dir, 'package.json'), '{}');
    // A script file, not `node -e`: on Windows the page server starts through the shell, which splits `-e` code at its spaces.
    await writeFile(join(dir, 'fails.cjs'), "console.error('Module not found: next');process.exit(1);");
    const states: LiveState[] = [];
    live = watchLive(dir, (s) => states.push(s), {
      pollMs: 50,
      maxStarts: 1,
      command: async () => ({ cmd: process.execPath, args: ['fails.cjs'] }),
    });
    const bad = await until(states, (s) => s.note.startsWith('The page didn’t start'));
    expect(bad.note).toContain('Module not found: next');
    await until(states, (s) => s.note.startsWith('The live view stopped trying after 1 start'));
  });
});

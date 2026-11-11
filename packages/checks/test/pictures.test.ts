import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { browserChoice, serveCommand, takePictures } from '../src/index.ts';

// The browser already on the computer: Edge on Windows, Chrome on Linux, or AIP_BROWSER.
const env = process.env;

describe('pictures', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'aip-pic-')));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uses Edge on Windows and Chrome on Linux, unless a browser path is given', () => {
    expect(browserChoice({}, 'win32')).toEqual({ channel: 'msedge', label: 'Edge' });
    expect(browserChoice({}, 'linux')).toEqual({ channel: 'chrome', label: 'Chrome' });
    expect(browserChoice({ AIP_BROWSER: '/opt/b/chrome' }, 'linux')).toEqual({ executablePath: '/opt/b/chrome', label: '/opt/b/chrome' });
  });

  it('knows how to show Next.js, Vite and plain pages', async () => {
    expect(await serveCommand(dir)).toBeNull();
    await writeFile(join(dir, 'index.html'), '<p>x</p>');
    expect(await serveCommand(dir)).toBe('static');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ devDependencies: { vite: '7' } }));
    expect(await serveCommand(dir)).toEqual({ cmd: 'pnpm', args: ['exec', 'vite', '--strictPort', '--port'] });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '16' } }));
    expect(await serveCommand(dir)).toEqual({ cmd: 'pnpm', args: ['exec', 'next', 'dev', '-p'] });
  });

  it('says plainly when there’s no page to show', async () => {
    const r = await takePictures(dir, join(dir, 'out'));
    expect(r.pictures).toEqual([]);
    expect(r.checks).toEqual([{ name: 'pictures', passed: false, free: true, advisory: true, detail: r.note }]);
    expect(r.note).toBe('No pictures: there’s no page to show (no Next.js or Vite app, and no index.html).');
  });

  it('takes desktop and phone pictures, checks accessibility and phone width, and spots changed screens', async () => {
    await writeFile(
      join(dir, 'index.html'),
      '<!doctype html><html lang="en"><head><title>Rota</title><meta name="viewport" content="width=device-width"></head><body><main><h1>Rota</h1><img src="a.png"><div style="width:900px">wide</div></main></body></html>',
    );
    const out = join(dir, 'pics');
    const first = await takePictures(dir, out, { env });
    expect(first.note).toMatch(/^Pictures taken with .+\.$/);
    expect(first.changed).toBeNull();
    expect(first.pictures.map((p) => p.name)).toEqual(['desktop', 'phone']);
    const png = await readFile(join(out, 'desktop.png'));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    const axe = first.checks.find((c) => c.name === 'axe')!;
    expect(axe).toMatchObject({ passed: false, advisory: true });
    expect(axe.detail).toContain('image-alt');
    expect(first.checks.find((c) => c.name === 'phone-overflow')).toMatchObject({ passed: false, advisory: true });
    expect(first.checks.find((c) => c.name === 'phone-overflow')?.detail).toMatch(/^Too wide for a phone: the page is \d+px on a 390px screen/);

    const same = await takePictures(dir, join(dir, 'pics2'), { env, previous: first.pictures });
    expect(same.changed).toBe(false);
    await writeFile(join(dir, 'index.html'), '<!doctype html><html lang="en"><head><title>Rota</title><meta name="viewport" content="width=device-width"></head><body><main><h1>New rota</h1></main></body></html>');
    const next = await takePictures(dir, join(dir, 'pics3'), { env, previous: first.pictures });
    expect(next.changed).toBe(true);
    expect(next.note).toContain('the screens changed since the last build');
    expect(next.checks.map((c) => [c.name, c.passed])).toEqual([
      ['axe', true],
      ['phone-overflow', true],
    ]);
  }, 60_000);
});

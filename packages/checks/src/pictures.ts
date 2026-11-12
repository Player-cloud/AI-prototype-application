/**
 * Step 9c: desktop and phone pictures of the build, taken every build with the browser already on
 * the computer (Edge on Windows, Chrome on Linux; nothing is downloaded). Two free checks come
 * with them: accessibility (axe) and whether the page fits a phone's width. Both are advice: they're
 * shown but don't stop Keep. The pictures are compared with the last build's, so the report can say
 * whether the screens changed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as netServer } from 'node:net';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { CheckResult } from './index.js';
import { packageManager, projectEnv } from './tests.js';

export interface Picture { name: 'desktop' | 'phone'; path: string; hash: string }

export interface PicturesResult {
  pictures: Picture[];
  /** axe and phone-overflow; advice only. */
  checks: CheckResult[];
  /** True or false against the last build's pictures; null when there's nothing to compare with. */
  changed: boolean | null;
  /** Plain words: what happened, or why there are no pictures. */
  note: string;
}

export const SIZES = {
  desktop: { width: 1280, height: 800, isMobile: false },
  phone: { width: 390, height: 844, isMobile: true },
} as const;

const WAIT_FOR_SERVER = 120_000;
const PAGE_TIMEOUT = 30_000;

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/** A page server for the build's copy: how to start it, or null when there's no page to show. */
export interface Serve { cmd: string; args: string[] } // run with the port added
export async function serveCommand(dir: string): Promise<Serve | 'static' | null> {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as typeof pkg;
  } catch {
    // no package.json: maybe a plain page
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const pm = await packageManager(dir);
  // npm needs "--", or it takes -p and --port as its own options (seen on joshua's laptop).
  const exec = pm === 'npm' ? ['exec', '--'] : ['exec'];
  if (deps.next) return { cmd: pm, args: [...exec, 'next', 'dev', '-p'] };
  if (deps.vite) return { cmd: pm, args: [...exec, 'vite', '--strictPort', '--port'] };
  if (await exists(join(dir, 'index.html'))) return 'static';
  return null;
}

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = netServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };

/** A tiny server for a plain page; it never serves anything outside the copy. */
function staticServer(dir: string, port: number): Promise<Server> {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    const file = resolve(root, `.${path.endsWith('/') ? `${path}index.html` : path}`);
    const rel = relative(root, file);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      res.writeHead(403).end();
      return;
    }
    stat(file).then(
      (s) => {
        if (!s.isFile()) return void res.writeHead(404).end();
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
        createReadStream(file).pipe(res);
      },
      () => res.writeHead(404).end(),
    );
  });
  return new Promise((res) => server.listen(port, '127.0.0.1', () => res(server)));
}

function stopTree(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

async function waitForPage(url: string, child: ChildProcess | null, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child && child.exitCode !== null) throw new Error('the page server stopped before the page was ready');
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the page wasn’t ready after ${Math.round(timeoutMs / 1000)} seconds`);
}

/** Edge on Windows, Chrome on Linux, or the browser named in AIP_BROWSER (a full path). */
export function browserChoice(env: NodeJS.ProcessEnv = process.env, platform = process.platform): { channel?: string; executablePath?: string; label: string } {
  if (env.AIP_BROWSER) return { executablePath: env.AIP_BROWSER, label: env.AIP_BROWSER };
  return platform === 'win32' ? { channel: 'msedge', label: 'Edge' } : { channel: 'chrome', label: 'Chrome' };
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface AxeViolation { id: string; impact: string | null; help: string; nodes: unknown[] }

export async function takePictures(
  dir: string,
  outDir: string,
  opts: { previous?: Picture[]; env?: NodeJS.ProcessEnv } = {},
): Promise<PicturesResult> {
  const none = (note: string): PicturesResult => ({
    pictures: [],
    checks: [{ name: 'pictures', passed: false, free: true, advisory: true, detail: note }],
    changed: null,
    note,
  });
  const serve = await serveCommand(dir);
  if (!serve) return none('No pictures: there’s no page to show (no Next.js or Vite app, and no index.html).');

  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  let child: ChildProcess | null = null;
  let server: Server | null = null;
  let log = '';
  try {
    if (serve === 'static') server = await staticServer(dir, port);
    else {
      child = spawn(serve.cmd, [...serve.args, String(port)], {
        cwd: dir,
        shell: process.platform === 'win32',
        detached: process.platform !== 'win32',
        windowsHide: true,
        env: projectEnv({ PORT: String(port), BROWSER: 'none', CI: '1' }),
      });
      const keep = (b: Buffer) => (log = `${log}${b.toString()}`.slice(-2000));
      child.stdout?.on('data', keep);
      child.stderr?.on('data', keep);
    }
    try {
      await waitForPage(url, child, WAIT_FOR_SERVER);
    } catch (err) {
      return none(`No pictures: ${(err as Error).message}.${log ? `\n${log.trim()}` : ''}`);
    }

    const choice = browserChoice(opts.env);
    const { chromium } = await import('playwright-core');
    let browser: import('playwright-core').Browser;
    try {
      browser = await chromium.launch({ headless: true, ...(choice.channel ? { channel: choice.channel } : { executablePath: choice.executablePath }) });
    } catch (err) {
      return none(`No pictures: couldn’t open ${choice.label} (${(err as Error).message.split('\n')[0]}).`);
    }
    try {
      await mkdir(outDir, { recursive: true });
      const pictures: Picture[] = [];
      const checks: CheckResult[] = [];
      for (const name of ['desktop', 'phone'] as const) {
        const size = SIZES[name];
        const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: size.isMobile, hasTouch: size.isMobile });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'load', timeout: PAGE_TIMEOUT });
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
        const png = await page.screenshot({ type: 'png' });
        const path = join(outDir, `${name}.png`);
        await writeFile(path, png);
        pictures.push({ name, path, hash: sha(png) });
        if (name === 'desktop') {
          const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
          await page.addScriptTag({ content: await readFile(axePath, 'utf8') });
          const violations = (await page.evaluate(async () => {
            const axe = (globalThis as unknown as { axe: { run(): Promise<{ violations: AxeViolation[] }> } }).axe;
            return (await axe.run()).violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map(() => 0) }));
          })) as AxeViolation[];
          const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
          checks.push({
            name: 'axe',
            passed: serious.length === 0,
            free: true,
            advisory: true,
            detail: serious.length
              ? serious.slice(0, 10).map((v) => `${v.help} (${v.id}, ${v.nodes.length} place${v.nodes.length === 1 ? '' : 's'})`).join('\n')
              : `No serious accessibility problems${violations.length ? ` (${violations.length} minor)` : ''}.`,
          });
        } else {
          // Against the phone's own width: a phone browser zooms out to fit a wide page.
          const widths = { page: await page.evaluate(() => document.documentElement.scrollWidth), screen: size.width };
          const fits = widths.page <= widths.screen + 1;
          checks.push({
            name: 'phone-overflow',
            passed: fits,
            free: true,
            advisory: true,
            detail: fits ? 'Fits a phone’s width.' : `Too wide for a phone: the page is ${widths.page}px on a ${widths.screen}px screen, so it scrolls sideways.`,
          });
        }
        await context.close();
      }
      const prev = opts.previous ?? [];
      const changed = prev.length ? pictures.some((p) => prev.find((q) => q.name === p.name)?.hash !== p.hash) : null;
      const note = `Pictures taken with ${choice.label}${changed === null ? '.' : changed ? '; the screens changed since the last build.' : '; the screens look the same as the last build.'}`;
      return { pictures, checks, changed, note };
    } finally {
      await browser.close();
    }
  } finally {
    if (child) stopTree(child);
    if (server) await new Promise((r) => server!.close(() => r(undefined)));
  }
}

/**
 * V2 item A: watch the build live. While the model works, the app runs the build copy's own page
 * (next dev, vite, or a plain index.html) on this computer, so the Build screen can show it as it
 * changes. Next.js and Vite update the page themselves; a plain page is reloaded by the screen.
 *
 * It waits until the copy has a page to show (and its packages are installed), starts the server,
 * and starts it again if it stops, a few times at most. It only ever listens on 127.0.0.1, never
 * downloads anything, and is always stopped before the final pictures and when the build ends.
 */
import type { ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { freePort, serveCommand, startServer, staticServer, stopTree, waitForPage, type Serve } from './pictures.js';

export interface LiveState {
  /** The page to show, or null while there's nothing to show yet. */
  url: string | null;
  /** Plain words: what the live view is doing. */
  note: string;
  /** True for a plain page, which doesn't update itself: the screen reloads it as the build changes. */
  reloads: boolean;
}

export interface LiveOptions {
  /** How often to look again for a page, or at a stopped server. */
  pollMs?: number;
  /** How long a server may take to show its page. */
  waitMs?: number;
  /** Starts before the live view gives up for this build. */
  maxStarts?: number;
  /** How to serve the copy; serveCommand unless a test says otherwise. */
  command?(dir: string): Promise<Serve | 'static' | null>;
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

const ended = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null;

export class LivePreview {
  private readonly dir: string;
  private readonly onChange: (s: LiveState) => void;
  private readonly pollMs: number;
  private readonly waitMs: number;
  private readonly maxStarts: number;
  private readonly command: (dir: string) => Promise<Serve | 'static' | null>;
  private child: ChildProcess | null = null;
  private server: Server | null = null;
  /** What is being served now ('' when nothing is). */
  private serving = '';
  private starts = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: Promise<void> | null = null;
  private last = '';

  constructor(dir: string, onChange: (s: LiveState) => void, opts: LiveOptions = {}) {
    this.dir = dir;
    this.onChange = onChange;
    this.pollMs = opts.pollMs ?? 3_000;
    this.waitMs = opts.waitMs ?? 120_000;
    this.maxStarts = opts.maxStarts ?? 5;
    this.command = opts.command ?? serveCommand;
  }

  start(): this {
    this.tick();
    return this;
  }

  /** Stops the server and stops looking. Safe to call more than once. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.current;
    await this.halt();
  }

  private say(url: string | null, note: string, reloads = false) {
    const key = `${url}|${note}|${reloads}`;
    if (key === this.last || this.stopped) return;
    this.last = key;
    this.onChange({ url, note, reloads });
  }

  private tick() {
    if (this.stopped) return;
    this.current = this.look()
      .catch((err: Error) => this.say(null, `The live view hit a problem: ${err.message.split('\n')[0]}`))
      .finally(() => {
        this.current = null;
        if (!this.stopped) this.timer = setTimeout(() => this.tick(), this.pollMs);
      });
  }

  private async halt() {
    const child = this.child;
    const server = this.server;
    this.child = null;
    this.server = null;
    this.serving = '';
    if (child) await stopTree(child);
    if (server) await new Promise((r) => server.close(() => r(undefined)));
  }

  private async look() {
    if (this.child && ended(this.child)) {
      await this.halt();
      this.say(null, 'The page stopped. The app will start it again.');
    }
    const serve = await this.command(this.dir);
    const kind = serve === null ? '' : JSON.stringify(serve);
    if (kind && kind === this.serving) return; // still serving the same kind of page
    if (this.serving) await this.halt(); // the build changed what kind of page it is
    if (!serve) return this.say(null, 'Waiting for the build to make a page to show.');
    if (serve !== 'static' && (await exists(join(this.dir, 'package.json'))) && !(await exists(join(this.dir, 'node_modules')))) {
      return this.say(null, 'Waiting for the build to install its packages.');
    }
    if (this.starts >= this.maxStarts) {
      return this.say(null, `The live view stopped trying after ${this.maxStarts} start${this.maxStarts === 1 ? '' : 's'}. The pictures at the end still run.`);
    }
    this.starts += 1;
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    let log = () => '';
    if (serve === 'static') this.server = await staticServer(this.dir, port);
    else ({ child: this.child, log } = startServer(this.dir, serve, port));
    this.serving = kind;
    if (this.stopped) return this.halt();
    this.say(null, 'Starting the page…');
    try {
      await waitForPage(url, this.child, this.waitMs);
    } catch (err) {
      await this.halt();
      const tail = log().trim().split('\n').at(-1);
      return this.say(null, `The page didn’t start: ${(err as Error).message}${tail ? ` (${tail})` : ''}. The app will try again.`);
    }
    if (this.stopped) return this.halt();
    this.say(url, 'Live: the build’s own copy, updating as it changes.', serve === 'static');
  }
}

/** Starts a live view of a build's copy. */
export function watchLive(dir: string, onChange: (s: LiveState) => void, opts?: LiveOptions): LivePreview {
  return new LivePreview(dir, onChange, opts).start();
}

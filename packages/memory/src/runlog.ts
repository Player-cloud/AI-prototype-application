/**
 * Step 9a: one row per feature build, kept in history.sqlite on this computer next to the spend
 * records and change history. It's what Keep, Undo and the 1–5 rating act on, and the evidence the
 * app learns from later (step 9d).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 'running': the build is going now (its row is added at the start, and its id is the build ID).
 * 'built': finished, waiting for Keep or Undo. 'kept' / 'undone': joshua decided.
 * 'failed': it threw (model error, cost limit, crash...), see `cause`. 'stopped': joshua pressed Stop.
 * 'interrupted': the app closed while it was running, so nobody knows how it ended.
 * Only 'built' can be kept; failed, stopped and interrupted builds stay as a record.
 */
export type RunStatus = 'running' | 'built' | 'kept' | 'undone' | 'failed' | 'stopped' | 'interrupted';

/** Why a build failed. Same words as the tools' health records (kept here so memory stays one piece). */
export type RunCause = 'model' | 'tool' | 'budget' | 'network' | 'provider' | 'setup' | 'stopped' | 'unknown';

/** The row written when a build starts: the build ID is the row's id. */
export interface StartedRun {
  at: Date;
  slug: string;
  feature: string;
  path: string;
  branch: string;
  base: string;
  model: string;
}

/** A build that threw: why, in plain words, and what it cost so far. */
export interface RunFailure {
  status: 'failed' | 'stopped';
  /** Only for 'failed'; a stop has no cause. */
  cause?: RunCause;
  /** The plain message. Messages are already cleaned of keys before they get here. */
  error: string;
  costUsd: number | null;
  ms: number | null;
  at: Date;
}

/** A picture of the build (step 9c): where it is and its hash, to spot changed screens. */
export interface RunPicture { name: string; path: string; hash: string }

/** One free check's result, as the checks package reports it. */
export interface RunCheck { name: string; passed: boolean; advisory?: boolean; detail?: string }

export interface NewRun {
  at: Date;
  slug: string;
  feature: string;
  /** The run's own copy (git worktree) and branch. */
  path: string;
  branch: string;
  /** The commit it started from. */
  base: string;
  model: string;
  costUsd: number | null;
  testsPassed: boolean;
  fixAttempts: number;
  summary: string;
  /** The free checks after the tests (step 9b). */
  checks?: RunCheck[];
  /** Desktop and phone pictures (step 9c). */
  pictures?: RunPicture[];
  /** CI-4: how long the build took, start to finish; null when not measured (older builds). */
  ms?: number | null;
}

export interface Run extends Omit<NewRun, 'at' | 'checks' | 'pictures' | 'ms'> {
  id: number;
  /** Why it failed; null unless status is 'failed'. */
  cause: RunCause | null;
  /** The plain message of a failed, stopped or interrupted build; '' otherwise. */
  error: string;
  /** When a failed, stopped or interrupted build ended; null for the rest. */
  endedAt: string | null;
  ms: number | null;
  checks: RunCheck[];
  pictures: RunPicture[];
  at: string;
  status: RunStatus;
  /** 1–5, or null when not rated yet. */
  rating: number | null;
  decidedAt: string | null;
  /** After Keep: the merge commit in joshua's copy, and the branch it went into. */
  mergeCommit: string;
  keptInto: string;
}

/** Runs kept; older ones are dropped. */
export const KEEP_RUNS = 500;

interface Row {
  id: number;
  at: string;
  slug: string;
  feature: string;
  path: string;
  branch: string;
  base: string;
  model: string;
  cost_usd: number | null;
  tests_passed: number;
  fix_attempts: number;
  summary: string;
  status: RunStatus;
  rating: number | null;
  decided_at: string | null;
  merge_commit: string;
  kept_into: string;
  checks: string;
  pictures: string;
  ms: number | null;
  cause: RunCause | null;
  error: string;
  ended_at: string | null;
}

function parseList<T>(raw: string): T[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function toRun(r: Row): Run {
  return {
    id: r.id,
    at: r.at,
    slug: r.slug,
    feature: r.feature,
    path: r.path,
    branch: r.branch,
    base: r.base,
    model: r.model,
    costUsd: r.cost_usd,
    testsPassed: r.tests_passed === 1,
    fixAttempts: r.fix_attempts,
    summary: r.summary,
    status: r.status,
    rating: r.rating,
    decidedAt: r.decided_at,
    mergeCommit: r.merge_commit,
    keptInto: r.kept_into,
    checks: parseList<RunCheck>(r.checks),
    pictures: parseList<RunPicture>(r.pictures),
    ms: r.ms ?? null,
    cause: r.cause ?? null,
    error: r.error ?? '',
    endedAt: r.ended_at ?? null,
  };
}

/** Builds started by this running program, as "file#id". Any other 'running' row is left over. */
const LIVE = new Set<string>();

export class RunLog {
  private constructor(private readonly db: DatabaseSync, private readonly path: string) {}

  /** Opens (or creates) the history file. ':memory:' works for tests. */
  static open(path: string): RunLog {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY,
      at TEXT NOT NULL,
      slug TEXT NOT NULL,
      feature TEXT NOT NULL,
      path TEXT NOT NULL,
      branch TEXT NOT NULL,
      base TEXT NOT NULL,
      model TEXT NOT NULL,
      cost_usd REAL,
      tests_passed INTEGER NOT NULL,
      fix_attempts INTEGER NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'built',
      rating INTEGER,
      decided_at TEXT,
      merge_commit TEXT NOT NULL DEFAULT '',
      kept_into TEXT NOT NULL DEFAULT '',
      checks TEXT NOT NULL DEFAULT '[]',
      pictures TEXT NOT NULL DEFAULT '[]',
      ms INTEGER
    )`);
    // Files made before steps 9b and 9c lack these columns.
    const cols = (db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).map((c) => c.name);
    for (const col of ['checks', 'pictures']) {
      if (!cols.includes(col)) db.exec(`ALTER TABLE runs ADD COLUMN ${col} TEXT NOT NULL DEFAULT '[]'`);
    }
    // ...and files made before CI-4 lack the build time.
    if (!cols.includes('ms')) db.exec('ALTER TABLE runs ADD COLUMN ms INTEGER');
    // ...and files made before run records lack the cause, the error and the end time.
    if (!cols.includes('cause')) db.exec('ALTER TABLE runs ADD COLUMN cause TEXT');
    if (!cols.includes('error')) db.exec("ALTER TABLE runs ADD COLUMN error TEXT NOT NULL DEFAULT ''");
    if (!cols.includes('ended_at')) db.exec('ALTER TABLE runs ADD COLUMN ended_at TEXT');
    const log = new RunLog(db, path);
    log.sweepInterrupted();
    return log;
  }

  private key(id: number): string {
    return `${this.path}#${id}`;
  }

  /**
   * A row still 'running' that this program didn't start is a build the app was closed (or crashed)
   * during. It becomes 'interrupted'. Done whenever the file is opened, so lists never show it as running.
   */
  private sweepInterrupted(): void {
    const rows = this.db.prepare("SELECT id FROM runs WHERE status = 'running'").all() as { id: number }[];
    const now = new Date().toISOString();
    for (const { id } of rows) {
      if (LIVE.has(this.key(id))) continue;
      this.db
        .prepare("UPDATE runs SET status = 'interrupted', error = ?, ended_at = ? WHERE id = ? AND status = 'running'")
        .run('The app was closed while this build was running.', now, id);
    }
  }

  private prune(): void {
    // Only decided or ended runs are dropped; one waiting for Keep or Undo, or still running, is never lost.
    this.db
      .prepare("DELETE FROM runs WHERE status NOT IN ('built', 'running') AND id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT ?)")
      .run(KEEP_RUNS);
  }

  /** Adds the row at the start of a build. Its id is the build ID that its spend rows carry too. */
  start(r: StartedRun): number {
    const res = this.db
      .prepare("INSERT INTO runs (at, slug, feature, path, branch, base, model, tests_passed, fix_attempts, summary, status) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, '', 'running')")
      .run(r.at.toISOString(), r.slug, r.feature, r.path, r.branch, r.base, r.model);
    const id = Number(res.lastInsertRowid);
    LIVE.add(this.key(id));
    this.prune();
    return id;
  }

  /** The build finished normally: the same row gets everything and waits for Keep or Undo. */
  finish(id: number, r: Pick<NewRun, 'costUsd' | 'testsPassed' | 'fixAttempts' | 'summary' | 'checks' | 'pictures' | 'ms'>): void {
    const res = this.db
      .prepare("UPDATE runs SET cost_usd = ?, tests_passed = ?, fix_attempts = ?, summary = ?, checks = ?, pictures = ?, ms = ?, status = 'built' WHERE id = ? AND status = 'running'")
      .run(r.costUsd, r.testsPassed ? 1 : 0, r.fixAttempts, r.summary, JSON.stringify(r.checks ?? []), JSON.stringify(r.pictures ?? []), r.ms ?? null, id);
    LIVE.delete(this.key(id));
    if (Number(res.changes) !== 1) throw new Error('That build isn’t running.');
  }

  /** The build threw or was stopped: the same row says why, with the cost so far. */
  fail(id: number, f: RunFailure): void {
    this.db
      .prepare("UPDATE runs SET status = ?, cause = ?, error = ?, cost_usd = ?, ms = ?, ended_at = ? WHERE id = ? AND status = 'running'")
      .run(f.status, f.status === 'failed' ? (f.cause ?? 'unknown') : null, f.error, f.costUsd, f.ms, f.at.toISOString(), id);
    LIVE.delete(this.key(id));
  }

  /** The build's copy of the code was removed (Undo of a failed, stopped or interrupted build). */
  markCleaned(id: number, at: Date): void {
    this.db.prepare("UPDATE runs SET decided_at = ? WHERE id = ? AND status IN ('failed', 'stopped', 'interrupted')").run(at.toISOString(), id);
  }

  add(r: NewRun): number {
    const res = this.db
      .prepare(
        'INSERT INTO runs (at, slug, feature, path, branch, base, model, cost_usd, tests_passed, fix_attempts, summary, checks, pictures, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(r.at.toISOString(), r.slug, r.feature, r.path, r.branch, r.base, r.model, r.costUsd, r.testsPassed ? 1 : 0, r.fixAttempts, r.summary, JSON.stringify(r.checks ?? []), JSON.stringify(r.pictures ?? []), r.ms ?? null);
    this.prune();
    return Number(res.lastInsertRowid);
  }

  get(id: number): Run | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return row ? toRun(row) : null;
  }

  /** Newest first, optionally for one project. */
  list(slug?: string, limit = 50): Run[] {
    const rows = (
      slug
        ? this.db.prepare('SELECT * FROM runs WHERE slug = ? ORDER BY id DESC LIMIT ?').all(slug, limit)
        : this.db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit)
    ) as unknown as Row[];
    return rows.map(toRun);
  }

  /** Keep or Undo. Only a run still waiting can be decided. */
  decide(id: number, status: 'kept' | 'undone', at: Date, kept: { mergeCommit: string; keptInto: string } = { mergeCommit: '', keptInto: '' }): void {
    const res = this.db
      .prepare("UPDATE runs SET status = ?, decided_at = ?, merge_commit = ?, kept_into = ? WHERE id = ? AND status = 'built'")
      .run(status, at.toISOString(), kept.mergeCommit, kept.keptInto, id);
    if (Number(res.changes) !== 1) throw new Error('That build was already kept or undone.');
  }

  /** Replaces a waiting run's saved checks (joshua approved new packages). Only a run still waiting. */
  setChecks(id: number, checks: RunCheck[]): void {
    const res = this.db.prepare("UPDATE runs SET checks = ? WHERE id = ? AND status = 'built'").run(JSON.stringify(checks), id);
    if (Number(res.changes) !== 1) throw new Error('That build was already kept or undone.');
  }

  /** joshua's 1–5 rating; can be changed. */
  rate(id: number, rating: number): void {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error('Rating must be a whole number from 1 to 5');
    // A build that failed, stopped or is still going has nothing to rate.
    const res = this.db.prepare("UPDATE runs SET rating = ? WHERE id = ? AND status IN ('built', 'kept', 'undone')").run(rating, id);
    if (Number(res.changes) !== 1) throw new Error('There’s no such build.');
  }

  /** The newest build of a project that has pictures, to compare screens with. */
  lastPictures(slug: string): RunPicture[] {
    const row = this.db.prepare("SELECT pictures FROM runs WHERE slug = ? AND pictures != '[]' ORDER BY id DESC LIMIT 1").get(slug) as { pictures: string } | undefined;
    return row ? parseList<RunPicture>(row.pictures) : [];
  }

  close(): void {
    this.db.close();
  }
}

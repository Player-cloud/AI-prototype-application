/**
 * Step 9a: one row per feature build, kept in history.sqlite on this computer next to the spend
 * records and change history. It's what Keep, Undo and the 1–5 rating act on, and the evidence the
 * app learns from later (step 9d).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 'built': waiting for Keep or Undo. */
export type RunStatus = 'built' | 'kept' | 'undone';

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
  };
}

export class RunLog {
  private constructor(private readonly db: DatabaseSync) {}

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
    return new RunLog(db);
  }

  add(r: NewRun): number {
    const res = this.db
      .prepare(
        'INSERT INTO runs (at, slug, feature, path, branch, base, model, cost_usd, tests_passed, fix_attempts, summary, checks, pictures, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(r.at.toISOString(), r.slug, r.feature, r.path, r.branch, r.base, r.model, r.costUsd, r.testsPassed ? 1 : 0, r.fixAttempts, r.summary, JSON.stringify(r.checks ?? []), JSON.stringify(r.pictures ?? []), r.ms ?? null);
    // Only finished runs are dropped; one waiting for Keep or Undo is never lost.
    this.db
      .prepare("DELETE FROM runs WHERE status != 'built' AND id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT ?)")
      .run(KEEP_RUNS);
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

  /** joshua's 1–5 rating; can be changed. */
  rate(id: number, rating: number): void {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error('Rating must be a whole number from 1 to 5');
    const res = this.db.prepare('UPDATE runs SET rating = ? WHERE id = ?').run(rating, id);
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

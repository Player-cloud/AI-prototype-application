/**
 * Step 10b: things that need joshua, kept in history.sqlite on this computer. Each one may have a
 * GitHub issue on the data repo, so he sees it on his phone. Only open items are shown in the
 * "Needs you" panel; an item closes when he deals with it (on the PC or, from 10c, his phone).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 'build': a build waiting for Keep or Undo. */
export type WorkKind = 'build';

export interface WorkItem {
  id: number;
  at: string;
  kind: WorkKind;
  /** The build run it's about. */
  runId: number;
  title: string;
  /** The GitHub issue, or 0 / '' when it wasn't posted (no token, or GitHub couldn't be reached). */
  issue: number;
  issueUrl: string;
  open: boolean;
  closedAt: string | null;
  /** Replies on GitHub up to this time have been read (10c). */
  readUpTo: string | null;
}

interface Row {
  id: number;
  at: string;
  kind: WorkKind;
  run_id: number;
  title: string;
  issue: number;
  issue_url: string;
  open: number;
  closed_at: string | null;
  read_up_to: string | null;
}

const toItem = (r: Row): WorkItem => ({
  id: r.id,
  at: r.at,
  kind: r.kind,
  runId: r.run_id,
  title: r.title,
  issue: r.issue,
  issueUrl: r.issue_url,
  open: r.open === 1,
  closedAt: r.closed_at,
  readUpTo: r.read_up_to,
});

/** Closed items kept; older ones are dropped. Open ones are never dropped. */
export const KEEP_ITEMS = 500;

export class WorkItems {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): WorkItems {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE IF NOT EXISTS work_items (
      id INTEGER PRIMARY KEY,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      run_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      issue INTEGER NOT NULL DEFAULT 0,
      issue_url TEXT NOT NULL DEFAULT '',
      open INTEGER NOT NULL DEFAULT 1,
      closed_at TEXT,
      read_up_to TEXT
    )`);
    return new WorkItems(db);
  }

  add(at: Date, kind: WorkKind, runId: number, title: string): number {
    const res = this.db.prepare('INSERT INTO work_items (at, kind, run_id, title) VALUES (?, ?, ?, ?)').run(at.toISOString(), kind, runId, title);
    this.db.prepare('DELETE FROM work_items WHERE open = 0 AND id NOT IN (SELECT id FROM work_items ORDER BY id DESC LIMIT ?)').run(KEEP_ITEMS);
    return Number(res.lastInsertRowid);
  }

  /** The GitHub issue it was posted as. */
  posted(id: number, issue: number, url: string, at: Date): void {
    this.db.prepare('UPDATE work_items SET issue = ?, issue_url = ?, read_up_to = ? WHERE id = ?').run(issue, url, at.toISOString(), id);
  }

  get(id: number): WorkItem | null {
    const row = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as Row | undefined;
    return row ? toItem(row) : null;
  }

  /** The open item for a build, if any. */
  forRun(runId: number): WorkItem | null {
    const row = this.db.prepare('SELECT * FROM work_items WHERE run_id = ? AND open = 1 ORDER BY id DESC LIMIT 1').get(runId) as Row | undefined;
    return row ? toItem(row) : null;
  }

  /** What needs joshua now, oldest first. */
  listOpen(): WorkItem[] {
    return (this.db.prepare('SELECT * FROM work_items WHERE open = 1 ORDER BY id').all() as unknown as Row[]).map(toItem);
  }

  /** joshua dealt with it. */
  done(id: number, at: Date): void {
    this.db.prepare('UPDATE work_items SET open = 0, closed_at = ? WHERE id = ? AND open = 1').run(at.toISOString(), id);
  }

  readTo(id: number, at: string): void {
    this.db.prepare('UPDATE work_items SET read_up_to = ? WHERE id = ?').run(at, id);
  }

  close(): void {
    this.db.close();
  }
}

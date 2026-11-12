/**
 * The change history behind one-click undo, kept next to the spend records in history.sqlite on
 * this computer. Each change keeps the whole "before" and "after", so it can be put back exactly.
 * An undo is itself a change, so it can be undone too.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 'settings': the app's settings.json. 'file': a text file, e.g. ledger.md in the data folder.
 * 'approval': joshua's OK for something (new packages in a build); shown in the history, nothing to put back.
 */
export type ChangeKind = 'settings' | 'file' | 'approval' | 'revert';

export interface NewChange {
  at: Date;
  kind: ChangeKind;
  /** Plain words, e.g. "Monthly budget £20 → £30". */
  label: string;
  /** For 'file': the file's full path. '' for settings. */
  target: string;
  before: string;
  after: string;
  /** Set when this change undoes an earlier one. */
  undoes?: number;
}

export interface Change extends Required<Omit<NewChange, 'at'>> {
  id: number;
  at: string;
  /** When it was undone, or null. */
  undoneAt: string | null;
}

/** Changes kept; older ones are dropped. */
export const KEEP_CHANGES = 200;
/** Biggest before/after kept (1 MB each); bigger changes can't be undone. */
export const MAX_CHANGE_CHARS = 1_000_000;

interface Row {
  id: number;
  at: string;
  kind: ChangeKind;
  label: string;
  target: string;
  before: string;
  after: string;
  undoes: number | null;
  undone_at: string | null;
}

function toChange(r: Row): Change {
  return {
    id: r.id,
    at: r.at,
    kind: r.kind,
    label: r.label,
    target: r.target,
    before: r.before,
    after: r.after,
    undoes: r.undoes ?? 0,
    undoneAt: r.undone_at,
  };
}

export class ChangeLog {
  private constructor(private readonly db: DatabaseSync) {}

  /** Opens (or creates) the history file. ':memory:' works for tests. */
  static open(path: string): ChangeLog {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE IF NOT EXISTS changes (
      id INTEGER PRIMARY KEY,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      target TEXT NOT NULL,
      before TEXT NOT NULL,
      after TEXT NOT NULL,
      undoes INTEGER,
      undone_at TEXT
    )`);
    return new ChangeLog(db);
  }

  /** Saves a change and returns its id. If it undoes an earlier change, that one is marked undone. */
  record(c: NewChange): number {
    if (c.before.length > MAX_CHANGE_CHARS || c.after.length > MAX_CHANGE_CHARS) {
      throw new Error('This change is too big to keep in the history.');
    }
    this.db.exec('BEGIN');
    try {
      const res = this.db
        .prepare('INSERT INTO changes (at, kind, label, target, before, after, undoes) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(c.at.toISOString(), c.kind, c.label, c.target, c.before, c.after, c.undoes ?? null);
      if (c.undoes) {
        this.db.prepare('UPDATE changes SET undone_at = ? WHERE id = ?').run(c.at.toISOString(), c.undoes);
      }
      this.db
        .prepare('DELETE FROM changes WHERE id NOT IN (SELECT id FROM changes ORDER BY id DESC LIMIT ?)')
        .run(KEEP_CHANGES);
      this.db.exec('COMMIT');
      return Number(res.lastInsertRowid);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  get(id: number): Change | null {
    const row = this.db.prepare('SELECT * FROM changes WHERE id = ?').get(id) as Row | undefined;
    return row ? toChange(row) : null;
  }

  /** Newest first. */
  list(limit = 30): Change[] {
    const rows = this.db.prepare('SELECT * FROM changes ORDER BY id DESC LIMIT ?').all(limit) as unknown as Row[];
    return rows.map(toChange);
  }

  close(): void {
    this.db.close();
  }
}

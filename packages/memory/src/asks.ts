/**
 * "Ask" rules that really ask. When a build is refused because a rule says "ask joshua first", the
 * request is kept here (in history.sqlite on this computer) and shows in the "Needs you" panel.
 * "Allow once" makes a single-use approval for that exact tool and input in that project, good for
 * 24 hours. "No" just closes the request. Nothing here can touch the "never" rules: the engine
 * only looks at approvals for ask decisions.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** How long an "Allow once" stays good if the build doesn't use it. */
export const APPROVAL_HOURS = 24;
/** Closed requests kept; open ones are never dropped. */
export const KEEP_ASKS = 200;

export interface NewAsk {
  slug: string;
  feature: string;
  /** The build's run branch. */
  branch: string;
  tool: string;
  /** The exact command or file path. */
  input: string;
  /** The gatekeeper's reason, in plain words. */
  reason: string;
}

export interface Ask extends NewAsk {
  id: number;
  at: string;
  open: boolean;
  /** 'allow' = Allow once, 'no' = No, null while open. */
  answer: 'allow' | 'no' | null;
  closedAt: string | null;
}

interface Row {
  id: number;
  at: string;
  slug: string;
  feature: string;
  branch: string;
  tool: string;
  input: string;
  reason: string;
  open: number;
  answer: 'allow' | 'no' | null;
  closed_at: string | null;
}

const toAsk = (r: Row): Ask => ({
  id: r.id,
  at: r.at,
  slug: r.slug,
  feature: r.feature,
  branch: r.branch,
  tool: r.tool,
  input: r.input,
  reason: r.reason,
  open: r.open === 1,
  answer: r.answer,
  closedAt: r.closed_at,
});

/** Trimmed, with runs of spaces, tabs and new lines made one space: "git  status " and "git status" match. */
export function normaliseInput(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export class Asks {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): Asks {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE IF NOT EXISTS asks (
      id INTEGER PRIMARY KEY,
      at TEXT NOT NULL,
      slug TEXT NOT NULL,
      feature TEXT NOT NULL,
      branch TEXT NOT NULL,
      tool TEXT NOT NULL,
      input TEXT NOT NULL,
      reason TEXT NOT NULL,
      open INTEGER NOT NULL DEFAULT 1,
      answer TEXT,
      closed_at TEXT
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS ask_approvals (
      id INTEGER PRIMARY KEY,
      ask_id INTEGER NOT NULL,
      slug TEXT NOT NULL,
      tool TEXT NOT NULL,
      input TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      used_branch TEXT
    )`);
    return new Asks(db);
  }

  /** Records a request. The same tool and input in the same project while one is open adds nothing. */
  add(at: Date, a: NewAsk): { id: number; fresh: boolean } {
    const input = normaliseInput(a.input);
    const same = this.db.prepare('SELECT id FROM asks WHERE open = 1 AND slug = ? AND tool = ? AND input = ?').get(a.slug, a.tool, input) as { id: number } | undefined;
    if (same) return { id: same.id, fresh: false };
    const res = this.db
      .prepare('INSERT INTO asks (at, slug, feature, branch, tool, input, reason) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(at.toISOString(), a.slug, a.feature, a.branch, a.tool, input, a.reason);
    this.db.prepare('DELETE FROM asks WHERE open = 0 AND id NOT IN (SELECT id FROM asks ORDER BY id DESC LIMIT ?)').run(KEEP_ASKS);
    return { id: Number(res.lastInsertRowid), fresh: true };
  }

  get(id: number): Ask | null {
    const row = this.db.prepare('SELECT * FROM asks WHERE id = ?').get(id) as Row | undefined;
    return row ? toAsk(row) : null;
  }

  /** What needs joshua now, oldest first. */
  listOpen(): Ask[] {
    return (this.db.prepare('SELECT * FROM asks WHERE open = 1 ORDER BY id').all() as unknown as Row[]).map(toAsk);
  }

  /** joshua's answer. Allow once makes a single-use approval; No only closes it. */
  decide(id: number, allow: boolean, at: Date): Ask {
    const ask = this.get(id);
    if (!ask) throw new Error('That request is no longer there.');
    if (!ask.open) throw new Error('That request was already answered.');
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE asks SET open = 0, answer = ?, closed_at = ? WHERE id = ?').run(allow ? 'allow' : 'no', at.toISOString(), id);
      if (allow) {
        const expires = new Date(at.getTime() + APPROVAL_HOURS * 3_600_000).toISOString();
        this.db.prepare('INSERT INTO ask_approvals (ask_id, slug, tool, input, expires_at) VALUES (?, ?, ?, ?, ?)').run(id, ask.slug, ask.tool, ask.input, expires);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.get(id)!;
  }

  /** Uses up a matching, unused, unexpired approval for this project. True when there was one. */
  consume(slug: string, tool: string, input: string, at: Date, branch: string): boolean {
    const row = this.db
      .prepare('SELECT id FROM ask_approvals WHERE slug = ? AND tool = ? AND input = ? AND used_at IS NULL AND expires_at > ? ORDER BY id LIMIT 1')
      .get(slug, tool, normaliseInput(input), at.toISOString()) as { id: number } | undefined;
    if (!row) return false;
    const res = this.db.prepare('UPDATE ask_approvals SET used_at = ?, used_branch = ? WHERE id = ? AND used_at IS NULL').run(at.toISOString(), branch, row.id);
    return Number(res.changes) === 1;
  }

  close(): void {
    this.db.close();
  }
}

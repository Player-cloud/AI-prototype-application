/**
 * Every model call's cost, kept in a small local SQLite file on this computer (Node's built-in
 * node:sqlite, so no extra package). Used to stop before the monthly budget is passed.
 * Undo history joins this file in build step 6.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface SpendRecord {
  at: Date;
  provider: string;
  model: string;
  job: string;
  inputTokens: number;
  outputTokens: number;
  /** null when the model's price isn't set in Settings yet. */
  costUsd: number | null;
}

export interface MonthSpend {
  month: string;
  usd: number;
  calls: number;
  /** Calls whose cost isn't known (no price set). Not counted in usd. */
  unknownCalls: number;
}

/** "2026-11" for a date, in this computer's local time (the budget month). */
export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export class SpendLog {
  private constructor(private readonly db: DatabaseSync) {}

  /** Opens (or creates) the spend file. ':memory:' works for tests. */
  static open(path: string): SpendLog {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE IF NOT EXISTS spend (
      id INTEGER PRIMARY KEY,
      at TEXT NOT NULL,
      month TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      job TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS spend_month ON spend (month)');
    return new SpendLog(db);
  }

  record(r: SpendRecord): void {
    this.db
      .prepare(
        'INSERT INTO spend (at, month, provider, model, job, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(r.at.toISOString(), monthKey(r.at), r.provider, r.model, r.job, r.inputTokens, r.outputTokens, r.costUsd);
  }

  month(month: string): MonthSpend {
    const row = this.db
      .prepare(
        'SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS calls, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown FROM spend WHERE month = ?',
      )
      .get(month) as { usd: number; calls: number; unknown: number | null };
    return { month, usd: row.usd, calls: row.calls, unknownCalls: row.unknown ?? 0 };
  }

  close(): void {
    this.db.close();
  }
}

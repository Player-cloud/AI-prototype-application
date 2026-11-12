/**
 * Reads joshua's private data repo (ai-prototype-data) from the folder chosen in Settings:
 * ledger.md, habits.md, rules.md and tools/<name>.md cards. Read-only here; writing ledger
 * lines and syncing to GitHub come in build step 5c.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCard, type ToolCard } from '@aip/tools';
import { type Note } from './index.js';
import { slugify } from './projects.js';

/** One ledger line: "- Name | status | job | evidence | tokens/cost | rating: x". */
export interface LedgerEntry { name: string; status: string; job: string; evidence: string; cost: string; rating: string }

/** on = in use (incl. backups), trial = waiting for a trial, off = switched off or not needed. */
export type ToolState = 'on' | 'trial' | 'untested' | 'off' | 'unknown';

/** A ledger line joined with its tool card, if it has one. */
export interface ToolView {
  /** CI-1: the stable ID. The card's file name, or the ledger name as a slug when there's no card. */
  id: string;
  name: string;
  state: ToolState;
  status: string;
  job: string;
  evidence: string;
  rating: string;
  card: ToolCard | null;
}

export interface DataRepo {
  folder: string;
  ledger: LedgerEntry[];
  habits: string[];
  rules: string[];
  tools: ToolView[];
  notes: Note[];
}

export function parseLedger(md: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const line of md.split(/\r?\n/)) {
    if (!line.startsWith('- ')) continue;
    const parts = line.slice(2).split(' | ').map((p) => p.trim());
    if (parts.length < 3) continue;
    const [name = '', status = '', job = '', evidence = '', cost = '', rating = ''] = parts;
    out.push({ name, status, job, evidence, cost, rating: rating.replace(/^rating:\s*/i, '') });
  }
  return out;
}

/** The "- " lines of a Markdown file (habits, rules). */
export function bullets(md: string): string[] {
  return md
    .split(/\r?\n/)
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).replace(/<!--.*?-->/g, '').trim());
}

export function toolState(status: string): ToolState {
  const s = status.toUpperCase();
  if (s.startsWith('NOT TESTED')) return 'untested';
  if (s.startsWith('NOT NEEDED') || s.startsWith('OFF')) return 'off';
  if (s.startsWith('TRIAL')) return 'trial';
  if (s.startsWith('ON') || s.startsWith('BACKUP')) return 'on';
  return 'unknown';
}

const plain = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * How well a ledger name fits a card: 3 = the card names it ("Ledger:" line), 2 = same name,
 * 1 = one name holds the other ("Haiku 5.5" / "Claude Haiku 5.5"), 0 = no match.
 */
function fit(entry: string, card: ToolCard): number {
  const e = plain(entry);
  if (card.ledger && plain(card.ledger) === e) return 3;
  const names = [plain(card.title), plain(card.name)].filter((c) => c !== '');
  if (names.includes(e) || slugify(entry) === card.name) return 2;
  if (card.ledger) return 0; // a card that names its ledger line matches only that line
  return names.some((c) => e.includes(c) || c.includes(e)) ? 1 : 0;
}

/**
 * Joins ledger lines to cards. Each card goes to the ledger line that fits it best; on a tie,
 * the shortest name ("EGM" before "EGM review"), so the result never depends on line order.
 * Each line gets its stable ID: the card's file name, or its own name as a slug.
 */
export function joinTools(ledger: LedgerEntry[], cards: ToolCard[]): ToolView[] {
  const cardFor = new Map<number, ToolCard>();
  for (const card of cards) {
    let best = -1;
    let bestFit = 0;
    ledger.forEach((e, i) => {
      if (cardFor.has(i)) return;
      const f = fit(e.name, card);
      if (f > bestFit || (f === bestFit && f > 0 && e.name.length < ledger[best]!.name.length)) {
        best = i;
        bestFit = f;
      }
    });
    if (best >= 0) cardFor.set(best, card);
  }
  const views: ToolView[] = ledger.map((e, i) => {
    const card = cardFor.get(i) ?? null;
    return { id: card?.name ?? slugify(e.name), name: e.name, state: toolState(e.status), status: e.status, job: e.job, evidence: e.evidence, rating: e.rating, card };
  });
  const used = new Set(cardFor.values());
  for (const c of cards) {
    if (!used.has(c)) views.push({ id: c.name, name: c.title, state: 'unknown', status: 'not in the ledger yet', job: '', evidence: '', rating: '', card: c });
  }
  return views;
}

/**
 * CI-2: duplicates and clashes in the ledger and cards, in plain words. Advice only: nothing is
 * switched on or off because of them.
 *  - Two lines with the same ID (their names make the same slug).
 *  - Two tools ON for the same job (a BACKUP is fine).
 *  - A card whose "Ledger:" line names a line that isn't there.
 */
export function toolClashes(tools: ToolView[]): string[] {
  const out: string[] = [];
  const byId = new Map<string, string[]>();
  for (const t of tools) byId.set(t.id, [...(byId.get(t.id) ?? []), t.name]);
  for (const [id, names] of byId) if (names.length > 1) out.push(`${names.join(' and ')} share the ID “${id}”. Rename one line, or give a card a Ledger: line.`);
  const byJob = new Map<string, string[]>();
  for (const t of tools) {
    if (t.state !== 'on' || /^BACKUP/i.test(t.status) || !t.job.trim() || t.job.trim() === '-') continue;
    const job = plain(t.job);
    byJob.set(job, [...(byJob.get(job) ?? []), t.name]);
  }
  for (const [, names] of byJob) {
    if (names.length > 1) {
      const job = tools.find((t) => t.name === names[0])!.job;
      out.push(`${names.join(' and ')} are both on for “${job}”. Keep one, or mark the other BACKUP.`);
    }
  }
  for (const t of tools) {
    if (t.card?.ledger && t.status === 'not in the ledger yet') out.push(`The ${t.card.name} card points to “${t.card.ledger}”, which isn’t in the ledger.`);
  }
  return out;
}

/** The stable ID for a tool name (as the ledger, a card or the app names it). */
export function toolIdFor(tools: ToolView[], name: string): string {
  const p = plain(name);
  const hit =
    tools.find((t) => t.id === name || plain(t.name) === p) ??
    tools.find((t) => t.card && (plain(t.card.title) === p || plain(t.card.ledger) === p));
  return hit?.id ?? slugify(name);
}

async function read(folder: string, file: string): Promise<string | null> {
  try {
    return await readFile(join(folder, file), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function note(name: string, md: string): Note {
  const description = md.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? name;
  return { name, description, body: md };
}

/** Loads the data repo. Throws a plain-words error when the folder isn't one. */
export async function loadDataRepo(folder: string): Promise<DataRepo> {
  const ledgerMd = await read(folder, 'ledger.md');
  if (ledgerMd === null) {
    throw new Error(`No ledger.md in ${folder}. Choose the folder where ai-prototype-data is cloned.`);
  }
  const habitsMd = (await read(folder, 'habits.md')) ?? '';
  const rulesMd = (await read(folder, 'rules.md')) ?? '';
  let cardFiles: string[] = [];
  try {
    cardFiles = (await readdir(join(folder, 'tools'))).filter((f) => f.endsWith('.md')).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const cards: ToolCard[] = [];
  const notes: Note[] = [note('ledger', ledgerMd), note('habits', habitsMd), note('rules', rulesMd)];
  for (const f of cardFiles) {
    const md = (await read(join(folder, 'tools'), f)) ?? '';
    const name = f.replace(/\.md$/, '');
    cards.push(parseCard(name, md));
    notes.push(note(name, md));
  }
  const ledger = parseLedger(ledgerMd);
  return { folder, ledger, habits: bullets(habitsMd), rules: bullets(rulesMd), tools: joinTools(ledger, cards), notes };
}

/**
 * What the engine reads first: one line per tool in use, then habits. Full cards and rules are
 * opened only when the engine is unsure (summaries first saved ~93% of tokens in trial round 1).
 */
export function firstRead(repo: DataRepo): string {
  const tools = repo.tools
    .filter((t) => t.state === 'on')
    .map((t) => `- ${t.name}: ${t.card?.what || t.job}`);
  return ['Tools in use:', ...tools, 'Habits:', ...repo.habits.map((h) => `- ${h}`)].join('\n');
}

/** Rough token count (about 4 characters a token), good enough to show the saving. */
export function roughTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

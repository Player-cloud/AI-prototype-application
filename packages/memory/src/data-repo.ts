/**
 * Reads joshua's private data repo (ai-prototype-data) from the folder chosen in Settings:
 * ledger.md, habits.md, rules.md and tools/<name>.md cards. Read-only here; writing ledger
 * lines and syncing to GitHub come in build step 5c.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCard, type ToolCard } from '@aip/tools';
import { type Note } from './index.js';

/** One ledger line: "- Name | status | job | evidence | tokens/cost | rating: x". */
export interface LedgerEntry { name: string; status: string; job: string; evidence: string; cost: string; rating: string }

/** on = in use (incl. backups), trial = waiting for a trial, off = switched off or not needed. */
export type ToolState = 'on' | 'trial' | 'untested' | 'off' | 'unknown';

/** A ledger line joined with its tool card, if it has one. */
export interface ToolView {
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
    .map((l) => l.slice(2).trim());
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

/** A card belongs to a ledger line when one name contains the other ("Claude Haiku 5.5" / "Haiku 5.5"). */
function sameTool(entry: string, card: ToolCard): boolean {
  const e = plain(entry);
  return [plain(card.title), plain(card.name)].some((c) => c !== '' && (e.includes(c) || c.includes(e)));
}

export function joinTools(ledger: LedgerEntry[], cards: ToolCard[]): ToolView[] {
  const used = new Set<ToolCard>();
  const views: ToolView[] = ledger.map((e) => {
    const card = cards.find((c) => !used.has(c) && sameTool(e.name, c)) ?? null;
    if (card) used.add(card);
    return { name: e.name, state: toolState(e.status), status: e.status, job: e.job, evidence: e.evidence, rating: e.rating, card };
  });
  for (const c of cards) {
    if (!used.has(c)) views.push({ name: c.title, state: 'unknown', status: 'not in the ledger yet', job: '', evidence: '', rating: '', card: c });
  }
  return views;
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

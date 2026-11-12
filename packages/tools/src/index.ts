/**
 * Tool cards: one short Markdown file per tool in the data repo (tools/<name>.md).
 * The engine reads only each card's first line ("What:") when choosing, so tools cost
 * almost nothing until picked (loading every tool adds ~30k tokens per call, trial round 4).
 *
 * CI-1: the card's file name is the tool's stable ID; nothing else needs one. Optional lines
 * "Kind:", "Version:" and "Ledger:" (the exact ledger.md name, when the names differ) say more.
 * Anything not written shows as unknown, never guessed.
 */

/** The kinds of capability Capability Intelligence tells apart. */
export const KINDS = ['model', 'tool', 'plugin', 'skill', 'mod', 'agent', 'workflow'] as const;
export type Kind = (typeof KINDS)[number] | 'unknown';

export interface ToolCard {
  /** The stable ID: the card's file name without .md. */
  name: string;
  title: string;
  what: string;
  useWhen: string;
  dontUseWhen: string;
  cost: string;
  kind: Kind;
  /** The version the card was written for ('' when not written down). */
  version: string;
  /** The ledger.md name this card belongs to, when written down ('' otherwise). */
  ledger: string;
}

export function kindOf(text: string): Kind {
  const k = text.trim().toLowerCase().replace(/s$/, '');
  return (KINDS as readonly string[]).includes(k) ? (k as Kind) : 'unknown';
}

export function parseCard(name: string, markdown: string): ToolCard {
  const field = (label: string) => markdown.match(new RegExp(`^${label}:\\s*(.+)$`, 'mi'))?.[1]?.trim() ?? '';
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? name;
  return {
    name,
    title,
    what: field('What'),
    useWhen: field('Use when'),
    dontUseWhen: field("Don't use when"),
    cost: field('Cost'),
    kind: kindOf(field('Kind')),
    version: field('Version'),
    ledger: field('Ledger'),
  };
}

/** The one-line summary the engine sees when picking tools. */
export function summaryLine(card: ToolCard): string {
  return `${card.name}: ${card.what}`;
}

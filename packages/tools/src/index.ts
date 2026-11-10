/**
 * Tool cards: one short Markdown file per tool in the data repo (tools/<name>.md).
 * The engine reads only each card's first line ("What:") when choosing, so tools cost
 * almost nothing until picked (loading every tool adds ~30k tokens per call, trial round 4).
 */

export interface ToolCard { name: string; what: string; useWhen: string; dontUseWhen: string; cost: string }

export function parseCard(name: string, markdown: string): ToolCard {
  const field = (label: string) => markdown.match(new RegExp(`^${label}:\\s*(.+)$`, 'mi'))?.[1]?.trim() ?? '';
  return { name, what: field('What'), useWhen: field('Use when'), dontUseWhen: field("Don't use when"), cost: field('Cost') };
}

/** The one-line summary the engine sees when picking tools. */
export function summaryLine(card: ToolCard): string {
  return `${card.name}: ${card.what}`;
}

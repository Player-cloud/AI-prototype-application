/**
 * "Ask" rules that really ask. When a build is refused because a rule says "ask joshua first",
 * the request goes in the "Needs you" panel with the exact command. "Allow once" lets that exact
 * thing through one time in that project (for 24 hours); "No" closes it. Both go in the history.
 */
import type { Ask } from '@aip/memory';

async function withAsks<T>(dbPath: string, fn: (a: import('@aip/memory').Asks) => T | Promise<T>): Promise<T> {
  const m = await import('@aip/memory');
  const a = m.Asks.open(dbPath);
  try {
    return await fn(a);
  } finally {
    a.close();
  }
}

/** The exact command or file path of a tool call, as shown to joshua. */
export function inputText(input: Record<string, unknown>): string {
  for (const k of ['command', 'file_path', 'path', 'notebook_path']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return JSON.stringify(input);
}

export interface AskContext {
  slug: string;
  feature: string;
  branch: string;
  dbPath: string;
  now?: Date;
}

/** Records the request (once while it's open). */
export function recordAsk(ctx: AskContext, tool: string, input: Record<string, unknown>, reason: string): Promise<{ id: number; fresh: boolean }> {
  return withAsks(ctx.dbPath, (a) => a.add(ctx.now ?? new Date(), { slug: ctx.slug, feature: ctx.feature, branch: ctx.branch, tool, input: inputText(input), reason }));
}

/** Uses up a matching "Allow once", if there is one. */
export function useApproval(ctx: AskContext, tool: string, input: Record<string, unknown>): Promise<boolean> {
  return withAsks(ctx.dbPath, (a) => a.consume(ctx.slug, tool, inputText(input), ctx.now ?? new Date(), ctx.branch));
}

/** The open requests for the "Needs you" panel. */
export function listAsks(dbPath: string): Promise<Ask[]> {
  return withAsks(dbPath, (a) => a.listOpen());
}

/** joshua's answer. It goes in the change history (nothing to put back). */
export async function decideAsk(dbPath: string, id: number, allow: boolean, now: Date): Promise<{ ask: Ask; note: string }> {
  const { approvalRecorded } = await import('./history.ts');
  const ask = await withAsks(dbPath, (a) => a.decide(id, allow, now));
  const what = `${ask.tool} in ${ask.slug} (${ask.feature}): ${ask.input}`;
  const note = allow ? `Allowed once: ${what}. It can be used one time in the next 24 hours.` : `Said No to: ${what}.`;
  await approvalRecorded(dbPath, allow ? `Allowed once: ${ask.tool} in ${ask.slug}` : `Said No: ${ask.tool} in ${ask.slug}`, `${what}. ${ask.reason}`, now);
  return { ask, note };
}

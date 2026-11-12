/**
 * Why a model run failed (Q-3). Only a failure that is clearly the model's own fault counts
 * towards the 3-failures-in-a-row switch-off (D-2). A cost limit, a network drop, a busy
 * provider, a bad key or no credit, or a Stop are not the model's fault.
 *
 * 'unknown' does NOT count towards switching off (the rule is "only what is clearly the
 * model's fault switches it off"), but it is still recorded and shown, so joshua can see it.
 */
export type Cause = 'model' | 'budget' | 'network' | 'provider' | 'setup' | 'stopped' | 'unknown';

/**
 * Sorts an error message into a cause. Matches the friendly messages from friendlyError()
 * and the raw texts they come from. The order matters: the first group that matches wins.
 */
export function failureCause(message: string): Cause {
  const t = message.toLowerCase();
  if (t.trim() === 'stopped.') return 'stopped';
  if (t.includes('cost limit') || t.includes('max_budget') || t.includes('budget is used up')) return 'budget';
  if (/enotfound|econnrefused|econnreset|etimedout|fetch failed|could not reach/.test(t)) return 'network';
  if (t.includes('api key') || t.includes('credit') || /\b(401|403)\b/.test(t)) return 'setup';
  if (/\b(429|500|501|502|503|504|529)\b/.test(t) || t.includes('overloaded') || t.includes('rate limit')) return 'provider';
  if (
    t.includes('ended without an answer') ||
    t.includes('error_max_turns') ||
    t.includes('max turns') ||
    t.includes('invalid tool') ||
    t.includes('malformed') ||
    t.includes('error_during_execution') ||
    t.includes('error_max_structured_output_retries')
  ) {
    return 'model';
  }
  return 'unknown';
}

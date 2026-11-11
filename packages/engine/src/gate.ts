/**
 * Every risky step goes through the gatekeeper first. The rules in packages/gatekeeper are
 * joshua's and are used as they are; this file only adds:
 *  - guards that keep the agent away from the rules themselves (the gatekeeper package and the
 *    app's settings, where joshua's extra rules live). These are never allowed, even with an OK;
 *  - joshua's extra ask-first rules from Settings.
 */
import { RULES, checkAction, type Decision, type Rule } from '@aip/gatekeeper';
import type { AppSettings, ExtraRule } from './settings.ts';

const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
/** Shell words that change files: redirects, in-place edits, moves, deletes, copies, git checkouts. */
const SHELL_WRITES = /(>|\bsed\s+-i|\btee\b|\bmv\b|\brm\b|\bcp\b|\bdel\b|Remove-Item|Set-Content|Out-File|\bgit\s+(checkout|restore|reset|apply)\b)/i;
const RULE_PLACES = /packages[\\/]+gatekeeper|app\.aiprototype\.desktop|settings\.json/i;

/** Never allowed: the agent changing the rules that guard it. */
export function guardsRules(tool: string, input: unknown): Decision {
  const text = JSON.stringify(input ?? '');
  if (!RULE_PLACES.test(text)) return { allow: true };
  if (WRITE_TOOLS.test(tool) || (/^(Bash|PowerShell)$/.test(tool) && SHELL_WRITES.test(text))) {
    return {
      allow: false,
      reason: 'Gatekeeper (protect-rules): the agent may never change the ask-first rules or the app’s settings',
      askJoshua: false,
    };
  }
  return { allow: true };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function extraToRules(extra: readonly ExtraRule[]): Rule[] {
  return extra.map((r, i) => ({
    id: `yours-${i + 1}`,
    pattern: new RegExp(escape(r.match), 'i'),
    reason: r.reason,
    askJoshua: true,
  }));
}

/** Checks one agent action: rule guards first, then the gatekeeper's rules, then joshua's extra ones. */
export function gate(tool: string, input: unknown, settings: AppSettings): Decision {
  const guard = guardsRules(tool, input);
  if (!guard.allow) return guard;
  return checkAction(tool, input, [...RULES, ...extraToRules(settings.extraRules)]);
}

export interface RuleView {
  id: string;
  reason: string;
  /** never = not allowed even with an OK; ask = waits for joshua's OK. */
  kind: 'never' | 'ask';
  source: 'gatekeeper' | 'app' | 'yours';
  /** For joshua's rules: the words watched for. */
  match?: string;
}

/** The rules as Settings shows them (patterns stay in code; reasons are plain words). */
export function listRules(settings: AppSettings): RuleView[] {
  return [
    { id: 'protect-rules', reason: 'the agent may never change the ask-first rules or the app’s settings', kind: 'never', source: 'app' },
    ...RULES.map((r): RuleView => ({ id: r.id, reason: r.reason, kind: r.askJoshua ? 'ask' : 'never', source: 'gatekeeper' })),
    ...settings.extraRules.map((r, i): RuleView => ({ id: `yours-${i + 1}`, reason: r.reason, kind: 'ask', source: 'yours', match: r.match })),
  ];
}

/**
 * Every risky step goes through the gatekeeper first. packages/gatekeeper owns all the rules,
 * including the guard that keeps the agent away from the rules and the app's settings (it always
 * runs first, whatever rules are passed). This file only adds joshua's own ask-first rules from Settings.
 */
import { PROTECT_RULES, RULES, SHELL_ALLOW_LIST_RULE, SHELL_RULES, checkAction, type Decision, type Rule } from '@aip/gatekeeper';
import type { AppSettings, ExtraRule } from './settings.ts';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function extraToRules(extra: readonly ExtraRule[]): Rule[] {
  return extra.map((r, i) => ({
    id: `yours-${i + 1}`,
    pattern: new RegExp(escape(r.match), 'i'),
    reason: r.reason,
    askJoshua: true,
  }));
}

/** Checks one agent action: the gatekeeper (its guard, then its rules), then joshua's extra rules. */
export function gate(tool: string, input: unknown, settings: AppSettings): Decision {
  return checkAction(tool, input, [...RULES, ...extraToRules(settings.extraRules)]);
}

export interface RuleView {
  id: string;
  reason: string;
  /** never = not allowed even with an OK; ask = waits for joshua's OK. */
  kind: 'never' | 'ask';
  source: 'gatekeeper' | 'yours';
  /** For joshua's rules: the words watched for. */
  match?: string;
}

/** The rules as Settings shows them (patterns stay in code; reasons are plain words). */
export function listRules(settings: AppSettings): RuleView[] {
  return [
    { id: PROTECT_RULES.id, reason: PROTECT_RULES.reason, kind: 'never', source: 'gatekeeper' },
    ...RULES.map((r): RuleView => ({ id: r.id, reason: r.reason, kind: r.askJoshua ? 'ask' : 'never', source: 'gatekeeper' })),
    ...[...SHELL_RULES, SHELL_ALLOW_LIST_RULE].map((r): RuleView => ({ id: r.id, reason: r.reason, kind: r.askJoshua ? 'ask' : 'never', source: 'gatekeeper' })),
    ...settings.extraRules.map((r, i): RuleView => ({ id: `yours-${i + 1}`, reason: r.reason, kind: 'ask', source: 'yours', match: r.match })),
  ];
}

/**
 * Gatekeeper: ask-first rules checked before every agent action.
 * The agent can never edit this package; only joshua can, through Settings.
 * Rules agreed 2026-11-10: money, new outside services, keys, deploys, pushes and bulk deletes need his OK.
 * 2026-11-11 (joshua, D-3): the guard that protects these rules lives here, so the gatekeeper is the
 * one authority. It always runs first and can't be switched off by passing other rules. rules.md is
 * deliberately not guarded: the app may update it and tell joshua, with history and undo.
 */

export type Decision =
  | { allow: true }
  | { allow: false; reason: string; askJoshua: boolean };

export interface Rule {
  id: string;
  pattern: RegExp;
  reason: string;
  /** false = never allowed, even with approval (for example reading key files). */
  askJoshua: boolean;
}

export const RULES: readonly Rule[] = [
  { id: 'key-files', pattern: /(^|[\/\\"'\s])\.env(\.[\w-]+)?\b|\.pem\b|id_rsa|id_ed25519/i, reason: 'reading or writing key files is never allowed', askJoshua: false },
  { id: 'push', pattern: /\bgit\s+push\b/i, reason: 'pushing code needs joshua\'s OK', askJoshua: true },
  { id: 'bulk-delete', pattern: /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)[a-z]*\b|Remove-Item\b[^\n]*-Recurse/i, reason: 'bulk delete needs joshua\'s OK', askJoshua: true },
  { id: 'deploy', pattern: /\b(vercel|netlify|fly)\s+(deploy|--prod)\b|\bdeploy\b.*--prod/i, reason: 'deploys need joshua\'s OK', askJoshua: true },
  { id: 'outside-service', pattern: /\b(curl|wget|Invoke-WebRequest|iwr)\b/i, reason: 'new outside services need joshua\'s OK', askJoshua: true },
  { id: 'global-install', pattern: /\b(npm|pnpm)\s+(i|install|add)\s+(-g|--global)\b/i, reason: 'global installs change the computer and need joshua\'s OK', askJoshua: true },
];

const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
/** Shell words that change files: redirects, in-place edits, moves, deletes, copies, git checkouts. */
const SHELL_WRITES = /(>|\bsed\s+-i|\btee\b|\bmv\b|\brm\b|\bcp\b|\bdel\b|Remove-Item|Set-Content|Out-File|\bgit\s+(checkout|restore|reset|apply)\b)/i;
/** This package and the app's settings (where joshua's own rules live). */
const PROTECTED_PLACES = /packages[\\/]+gatekeeper|app\.aiprototype\.desktop|settings\.json/i;

export const PROTECT_RULES = {
  id: 'protect-rules',
  reason: 'the agent may never change the ask-first rules or the app’s settings',
} as const;

/** Never allowed, even with an OK: the agent changing this package or the app's settings. */
export function protectRules(tool: string, input: unknown): Decision {
  const text = JSON.stringify(input ?? '');
  if (!PROTECTED_PLACES.test(text)) return { allow: true };
  if (WRITE_TOOLS.test(tool) || (/^(Bash|PowerShell)$/.test(tool) && SHELL_WRITES.test(text))) {
    return { allow: false, reason: `Gatekeeper (${PROTECT_RULES.id}): ${PROTECT_RULES.reason}`, askJoshua: false };
  }
  return { allow: true };
}

/**
 * Check one agent action (tool name plus its input). The protect-rules guard always runs first;
 * then the given rules (the built-in RULES unless a caller adds more).
 */
export function checkAction(tool: string, input: unknown, rules: readonly Rule[] = RULES): Decision {
  const guard = protectRules(tool, input);
  if (!guard.allow) return guard;
  const text = `${tool} ${JSON.stringify(input ?? '')}`;
  for (const rule of rules) {
    if (rule.pattern.test(text)) {
      return { allow: false, reason: `Gatekeeper (${rule.id}): ${rule.reason}`, askJoshua: rule.askJoshua };
    }
  }
  return { allow: true };
}

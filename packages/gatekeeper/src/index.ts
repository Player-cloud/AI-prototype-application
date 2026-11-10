/**
 * Gatekeeper: ask-first rules checked before every agent action.
 * The agent can never edit this package; only joshua can, through Settings.
 * Rules agreed 2026-11-10: money, new outside services, keys, deploys, pushes and bulk deletes need his OK.
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

/** Check one agent action (tool name plus its input) against the rules. */
export function checkAction(tool: string, input: unknown, rules: readonly Rule[] = RULES): Decision {
  const text = `${tool} ${JSON.stringify(input ?? '')}`;
  for (const rule of rules) {
    if (rule.pattern.test(text)) {
      return { allow: false, reason: `Gatekeeper (${rule.id}): ${rule.reason}`, askJoshua: rule.askJoshua };
    }
  }
  return { allow: true };
}

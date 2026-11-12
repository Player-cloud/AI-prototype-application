/**
 * Gatekeeper: ask-first rules checked before every agent action.
 * The agent can never edit this package; only joshua can, through Settings.
 * Rules agreed 2026-11-10: money, new outside services, keys, deploys, pushes and bulk deletes need his OK.
 * 2026-11-11 (joshua, D-3): the guard that protects these rules lives here, so the gatekeeper is the
 * one authority. It always runs first and can't be switched off by passing other rules. rules.md is
 * deliberately not guarded: the app may update it and tell joshua, with history and undo.
 */

export type Decision =
  /** `note`: allowed, but the shell allow-list (still in log-only mode) would have asked. */
  | { allow: true; note?: string }
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
 * then the given rules (the built-in RULES unless a caller adds more); then, for shell commands,
 * the shell policy below. `enforceAllowList` is only a parameter so tests can turn it on.
 */
export function checkAction(tool: string, input: unknown, rules: readonly Rule[] = RULES, enforceAllowList: boolean = SHELL_ALLOW_LIST_ENFORCED): Decision {
  const guard = protectRules(tool, input);
  if (!guard.allow) return guard;
  const text = `${tool} ${JSON.stringify(input ?? '')}`;
  for (const rule of rules) {
    if (rule.pattern.test(text)) {
      return { allow: false, reason: `Gatekeeper (${rule.id}): ${rule.reason}`, askJoshua: rule.askJoshua };
    }
  }
  const command = (input as { command?: unknown } | null | undefined)?.command;
  if (/^(Bash|PowerShell)$/.test(tool) && typeof command === 'string') return checkShell(command, enforceAllowList);
  return { allow: true };
}

/* ------------------------------------------------------------------------------------------------
 * Shell policy (2026-11-12, joshua's OK, decision Q-2). Runs after the guard and RULES, so their
 * reasons stay as they are. Tier A: risky shapes that always ask (or never, for hidden key files).
 * Tier B: an allow-list of known build programs, log-only until joshua flips the switch.
 * ---------------------------------------------------------------------------------------------- */

/** joshua flips this after 3 real builds. While false, unknown programs are allowed with a note. */
export const SHELL_ALLOW_LIST_ENFORCED = false;

export interface ShellRule {
  id: string;
  reason: string;
  askJoshua: boolean;
}

export const SHELL_RULES: readonly ShellRule[] = [
  { id: 'shell-obfuscation', reason: 'splitting a word with quotes or backslashes to hide a key file name is never allowed', askJoshua: false },
  { id: 'shell-substitution', reason: 'commands hidden inside commands (backticks, $( ), <( ), >( )) can’t be checked and need joshua’s OK', askJoshua: true },
  { id: 'shell-pipe-to-shell', reason: 'sending text into a shell or interpreter to run it needs joshua’s OK', askJoshua: true },
  { id: 'shell-eval', reason: 'running text or scripts as commands (eval, source, sh -c) needs joshua’s OK', askJoshua: true },
  { id: 'shell-environment', reason: 'changing the environment for a command (NAME=value, env, export, unset, alias) needs joshua’s OK', askJoshua: true },
  { id: 'shell-elevate', reason: 'running a command with higher rights (sudo and the like) needs joshua’s OK', askJoshua: true },
  { id: 'shell-git', reason: 'this git command can change settings, reach other computers or rewrite history, so it needs joshua’s OK', askJoshua: true },
  { id: 'shell-inline-code', reason: 'running code typed on the command line (node -e, python -c and the like) needs joshua’s OK', askJoshua: true },
  { id: 'shell-package-runner', reason: 'downloading and running a package (npx, pnpm dlx and the like) needs joshua’s OK', askJoshua: true },
  { id: 'shell-install-scripts', reason: 'this install would run package scripts; add --ignore-scripts, or use pnpm, or ask joshua', askJoshua: true },
  { id: 'shell-delete', reason: 'recursive or forced deletes, in any spelling, need joshua’s OK', askJoshua: true },
  { id: 'shell-links', reason: 'making links (ln, mklink, symbolic links, junctions) can reach outside the copy and needs joshua’s OK', askJoshua: true },
  { id: 'shell-network', reason: 'network tools (nc, ssh, scp, rsync and the like) need joshua’s OK', askJoshua: true },
  { id: 'shell-outside-home', reason: 'the home folder ($HOME, ~, %USERPROFILE%) is outside this copy and needs joshua’s OK', askJoshua: true },
];

/** Shown in Settings too. While the switch is off it only logs, which the reason says. */
export const SHELL_ALLOW_LIST_RULE: ShellRule = {
  id: 'shell-allow-list',
  reason: 'programs that aren’t known build commands need joshua’s OK (on trial: for now only noted in the build steps)',
  askJoshua: true,
};

const ALLOWED_PROGRAMS = new Set(
  ['pnpm', 'npm', 'yarn', 'node', 'tsc', 'vitest', 'jest', 'eslint', 'prettier', 'next', 'vite', 'playwright', 'tsx', 'git', 'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'echo', 'printf', 'pwd', 'cd', 'sort', 'uniq', 'diff', 'which', 'where', 'tree', 'sed', 'awk', 'mkdir', 'touch', 'cp', 'copy', 'mv', 'move', 'rm', 'del', 'test', '[', '[[', 'true', 'false', 'sleep', 'get-childitem', 'get-content', 'select-string', 'set-location', 'gci', 'gc', 'sls', 'sl'].map((n) => n.toLowerCase()),
);
const GIT_ALLOWED = new Set(['status', 'diff', 'log', 'show', 'add', 'commit', 'restore', 'checkout', 'switch', 'branch', 'rev-parse', 'ls-files', 'grep', 'mv', 'rm', 'stash', 'blame', 'init']);
const GIT_NAMED_RISKY = new Set(['config', 'remote', 'push', 'fetch', 'pull', 'clone', 'submodule', 'clean', 'reset', 'filter-branch', 'update-ref', 'gc']);
const PKG_SUBS_ALLOWED = new Set(['test', 'run', 'run-script', 'exec', 'lint', 'build', 'typecheck', 'list', 'ls', 'why', 'install', 'i', 'add', 'remove', 'rm', 'uninstall', 'audit', 'check', 'dev', 'start', 'format', 'outdated', 'vitest', 'tsc', 'jest', 'eslint', 'prettier', 'next', 'vite', 'playwright', 'tsx']);
const NPM_INSTALLS = new Set(['i', 'in', 'ins', 'inst', 'insta', 'instal', 'install', 'isntall', 'add', 'ci', 'clean-install', 'ic', 'install-clean', 'it', 'install-test', 'cit', 'install-ci-test', 'update', 'up', 'upgrade', 'rebuild', 'rb']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd']);
const NETWORK = new Set(['nc', 'ncat', 'netcat', 'socat', 'telnet', 'ssh', 'scp', 'sftp', 'ftp', 'rsync', 'invoke-restmethod', 'irm', 'start-bitstransfer']);
const WRAPPERS = new Set(['command', 'builtin', 'exec', 'time', 'nohup', 'nice', 'timeout', 'xargs', 'stdbuf', 'setsid', 'ionice']);
const ELEVATE = new Set(['sudo', 'doas', 'su', 'runas']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'fi', 'done', 'for', 'case', 'esac', 'select']);
const KEY_FILE = RULES.find((r) => r.id === 'key-files')!.pattern;
const HOME_VARS = /\$\{?(?:HOME|USERPROFILE|HOMEPATH|HOMEDRIVE|APPDATA|LOCALAPPDATA)(?![A-Za-z0-9_])|%(?:USERPROFILE|HOMEPATH|HOMEDRIVE|APPDATA|LOCALAPPDATA)%|\$env:(?:USERPROFILE|HOME|HOMEPATH|APPDATA|LOCALAPPDATA)\b/i;

interface Word {
  /** Without quotes, backslashes kept (so Windows paths still read as paths). */
  plain: string;
  /** Without quotes and backslashes (what the shell would run for `e\nv` or `.e""nv`). */
  bare: string;
  hadQuoteOrSlash: boolean;
}
interface Simple {
  words: Word[];
  /** Came after a single `|`. */
  piped: boolean;
}

/** Splits a command into simple commands on && || ; | & newlines and parentheses, outside quotes. */
function splitShell(cmd: string): { simples: Simple[]; substitution: boolean } {
  const simples: Simple[] = [];
  let words: Word[] = [];
  let piped = false;
  let plain = '';
  let bare = '';
  let marked = false;
  let started = false;
  let substitution = false;
  const flushWord = () => {
    if (started) words.push({ plain, bare, hadQuoteOrSlash: marked });
    plain = '';
    bare = '';
    marked = false;
    started = false;
  };
  const endCommand = (nextPiped: boolean) => {
    flushWord();
    if (words.length) simples.push({ words, piped });
    words = [];
    piped = nextPiped;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    const n = cmd[i + 1];
    if (c === '\\') {
      if (n === undefined) continue;
      if (n === '\n') {
        i++;
        continue;
      }
      plain += c + n;
      bare += n;
      marked = started = true;
      i++;
    } else if (c === "'") {
      marked = started = true;
      const end = cmd.indexOf("'", i + 1);
      const body = cmd.slice(i + 1, end === -1 ? undefined : end);
      plain += body;
      bare += body;
      i = end === -1 ? cmd.length : end;
    } else if (c === '"') {
      marked = started = true;
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        const d = cmd[j]!;
        if (d === '\\' && j + 1 < cmd.length) {
          plain += d + cmd[j + 1];
          bare += cmd[j + 1];
          j++;
          continue;
        }
        if (d === '`' || (d === '$' && cmd[j + 1] === '(')) substitution = true;
        plain += d;
        bare += d;
      }
      i = j;
    } else if (c === '`' || (c === '$' && n === '(') || ((c === '<' || c === '>') && n === '(')) {
      substitution = true;
      plain += c;
      bare += c;
      started = true;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      flushWord();
    } else if (c === '\n' || c === ';' || c === '(' || c === ')') {
      endCommand(false);
    } else if (c === '|') {
      if (n === '|') {
        i++;
        endCommand(false);
      } else {
        if (n === '&') i++;
        endCommand(true);
      }
    } else if (c === '&') {
      if (n === '&') {
        i++;
        endCommand(false);
      } else if (n === '>' || cmd[i - 1] === '>' || cmd[i - 1] === '<') {
        plain += c;
        bare += c;
        started = true;
      } else {
        endCommand(false);
      }
    } else if (c === '#' && !started) {
      while (i < cmd.length && cmd[i] !== '\n') i++;
      i--;
    } else {
      plain += c;
      bare += c;
      started = true;
    }
  }
  endCommand(false);
  return { simples, substitution };
}

/** Program names a word could mean: path stripped, .cmd/.exe stripped, lower case. */
function programNames(w: Word): string[] {
  const clean = (s: string) =>
    (s.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(cmd|exe|bat)$/, '');
  const names = [clean(w.plain), clean(w.bare)];
  return [...new Set(names)];
}

interface Finding {
  id: string;
  detail?: string;
}
interface Found {
  findings: Finding[];
  unknown: string[];
}

const shortCluster = (a: string): string | null => (/^-[A-Za-z]+$/.test(a) ? a.slice(1) : null);
/** Package manager subcommand, skipping options (and the values of the few that take one). */
function packageSub(args: string[]): { sub: string | undefined; rest: string[] } {
  const takesValue = new Set(['--filter', '-F', '-C', '--dir', '--prefix', '--cwd', '--workspace']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('-')) {
      if (takesValue.has(a)) i++;
      continue;
    }
    return { sub: a.toLowerCase(), rest: args.slice(i + 1) };
  }
  return { sub: undefined, rest: [] };
}
const hasIgnoreScripts = (args: string[]) => args.some((a) => /^--ignore-scripts(=(true|1))?$/i.test(a));

function gitCheck(args: string[]): string | undefined {
  let i = 0;
  for (; i < args.length && args[i]!.startsWith('-'); i++) {
    if (!['--no-pager', '--version', '--help'].includes(args[i]!)) return 'options before the git command (like -c, -C, --git-dir, --work-tree) can change where git works or run other programs';
  }
  const sub = args[i];
  if (sub === undefined) return undefined;
  const rest = args.slice(i + 1);
  if (GIT_NAMED_RISKY.has(sub)) return `git ${sub} can change settings, reach other computers or rewrite history`;
  if (!GIT_ALLOWED.has(sub)) return `git ${sub} isn’t one of the plain local git commands`;
  if (sub === 'branch') {
    const bad = rest.some((a) => {
      if (/^--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description)/.test(a)) return true;
      const c = shortCluster(a);
      return c !== null && /[dDmMcCfu]/.test(c);
    });
    if (bad) return 'git branch may only list or create local branches (no delete, rename, copy or force)';
  }
  if (sub === 'rm' && rest.some((a) => /^--(recursive|force)/.test(a) || /[rRf]/.test(shortCluster(a) ?? ''))) return 'git rm may not be recursive or forced';
  return undefined;
}

function isDeleteCall(names: string[], args: string[]): boolean {
  const has = (...n: string[]) => names.some((x) => n.includes(x));
  if (has('rm')) {
    return args.some((a) => {
      if (a === '--') return false;
      if (a.startsWith('--')) {
        const n = a.slice(2).split('=')[0]!;
        return n.length > 0 && ('recursive'.startsWith(n) || 'force'.startsWith(n));
      }
      return /[rRf]/.test(shortCluster(a) ?? '');
    });
  }
  if (has('del', 'erase', 'rd', 'rmdir')) return args.some((a) => /^\/[sf]$/i.test(a));
  if (has('remove-item', 'ri')) {
    return args.some((a) => {
      const m = /^-([a-z]+)$/i.exec(a);
      const n = m?.[1]?.toLowerCase();
      return !!n && ('recurse'.startsWith(n) || (n.length >= 2 && 'force'.startsWith(n)));
    });
  }
  return false;
}

function analyse(words: Word[], piped: boolean, found: Found): void {
  let w = words;
  if (/^(for|case|select)$/.test(w[0]!.plain)) return; // only a loop header: the commands inside come as their own parts
  while (w.length && KEYWORDS.has(w[0]!.plain)) w = w.slice(1);
  if (!w.length) return;
  // A leading NAME=value, or $env:NAME = ... changes the environment for what follows.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!.plain) || /^\$env:/i.test(w[0]!.plain)) {
    found.findings.push({ id: 'shell-environment' });
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!.plain)) w = w.slice(1);
    if (!w.length) return;
  }
  const names = programNames(w[0]!);
  const is = (...n: string[]) => names.some((x) => n.includes(x));
  const args = w.slice(1).map((a) => a.plain);
  const rest = w.slice(1);
  const add = (id: string, detail?: string) => found.findings.push({ id, detail });
  const innerOf = (list: Word[]) => {
    let k = 0;
    while (k < list.length && (list[k]!.plain.startsWith('-') || /^\d+(\.\d+)?[smhd]?$/.test(list[k]!.plain))) k++;
    return list.slice(k);
  };

  if (is(...ELEVATE)) {
    add('shell-elevate');
    analyse(innerOf(rest), piped, found);
    return;
  }
  if (is(...WRAPPERS)) {
    analyse(innerOf(rest), piped, found);
    return;
  }

  const readsStdinAsCode = () => !args.some((a) => !a.startsWith('-') || a === '-') || args.includes('-');
  const interpreter = is('node', 'deno', 'bun', 'ruby', 'perl', 'php') || names.some((n) => /^python[\d.]*$/.test(n) || n === 'py');
  if (piped && (is(...SHELLS) || (interpreter && readsStdinAsCode()))) add('shell-pipe-to-shell');

  if (is('eval', 'source', '.', 'iex', 'invoke-expression')) add('shell-eval');
  if (is('bash', 'sh', 'zsh', 'dash', 'ksh', 'fish') && args.some((a) => /^-[a-z]*c[a-z]*$/i.test(a))) add('shell-eval');
  if (is('cmd') && args.some((a) => /^\/[ck]$/i.test(a))) add('shell-eval');
  if (is('pwsh', 'powershell') && args.some((a) => /^-(c|com\w*|ec|enc\w*|e)$/i.test(a))) add('shell-eval');

  if (is('env', 'export', 'unset', 'alias', 'setx')) add('shell-environment');
  if (is('set') && args.some((a) => a === '-a' || a === 'allexport' || a.includes('='))) add('shell-environment');

  if (is('git')) {
    const detail = gitCheck(args);
    if (detail) add('shell-git', detail);
  }

  // Inline code.
  const beforeScript = (test: (a: string) => boolean) => {
    for (const a of args) {
      if (/\.(?:[cm]?[jt]s|py|rb|pl|php)$/i.test(a)) return false;
      if (test(a)) return true;
    }
    return false;
  };
  if (is('node') && beforeScript((a) => /^--(eval|print)(=|$)/.test(a) || /^-[a-z]*[ep][a-z]*$/.test(a))) add('shell-inline-code');
  if (names.some((n) => /^python[\d.]*$/.test(n) || n === 'py') && beforeScript((a) => /^-[a-z0-9]*c[a-z0-9]*$/i.test(a))) add('shell-inline-code');
  if (is('deno') && args[0] === 'eval') add('shell-inline-code');
  if (is('bun') && beforeScript((a) => /^--(eval|print)(=|$)/.test(a) || /^-[ep]$/.test(a))) add('shell-inline-code');
  if (is('ruby', 'perl') && beforeScript((a) => /^-[a-z]*[eE][a-z]*$/.test(a))) add('shell-inline-code');
  if (is('php') && args.includes('-r')) add('shell-inline-code');

  // Package runners and installs.
  if (is('npx', 'pnpx', 'bunx') || names.some((n) => n.startsWith('create-'))) add('shell-package-runner');
  const manager = is('pnpm', 'npm', 'yarn', 'bun');
  if (manager) {
    const { sub, rest: after } = packageSub(args);
    if (is('pnpm', 'yarn', 'bun') && (sub === 'dlx' || (is('bun') && sub === 'x'))) add('shell-package-runner');
    if (is('npm') && (sub === 'exec' || sub === 'x')) add('shell-package-runner');
    if (sub === 'create') add('shell-package-runner');
    if (is('npm') && (sub === 'init' || sub === 'innit') && after.some((a) => !a.startsWith('-'))) add('shell-package-runner');
    if (is('npm') && sub && NPM_INSTALLS.has(sub) && !hasIgnoreScripts(args)) add('shell-install-scripts');
    if (is('yarn') && (sub === 'add' || sub === 'install' || sub === 'upgrade' || (sub === undefined && !args.some((a) => /^(--version|-v|--help|-h)$/.test(a)))) && !hasIgnoreScripts(args)) add('shell-install-scripts');
    if (is('pnpm') && args.includes('--dangerously-allow-all-builds')) add('shell-install-scripts');
    // `pnpm exec x ...` runs x: check it like a command of its own.
    if ((is('pnpm') || is('yarn')) && sub === 'exec') {
      const at = args.indexOf('exec');
      analyse(rest.slice(at + 1), piped, found);
    }
    if (sub !== undefined && !PKG_SUBS_ALLOWED.has(sub) && !/^(test|lint|build|check|format|typecheck)[:\-]/.test(sub)) found.unknown.push(`${names[0]} ${sub}`);
  }

  // Deletes, links, network.
  if (isDeleteCall(names, args)) add('shell-delete');
  if (is('find') && (args.includes('-delete') || args.some((a, i) => /^-(exec|execdir|ok|okdir)$/.test(a) && /^(rm|rmdir|del|erase|unlink|shred)$/.test(programNames({ plain: args[i + 1] ?? '', bare: args[i + 1] ?? '', hadQuoteOrSlash: false })[0]!)))) add('shell-delete');
  if (is('xargs') && args.some((a) => /^(rm|rmdir|del)$/.test(a))) add('shell-delete');
  if (is('ln', 'mklink')) add('shell-links');
  if (is('new-item', 'ni') && args.some((a) => /^(symboliclink|junction|hardlink)$/i.test(a))) add('shell-links');
  if (is('cmd') && args.some((a) => /^mklink$/i.test(a))) add('shell-links');
  if (is(...NETWORK)) add('shell-network');

  // Tier B bookkeeping: is this program a known build command?
  if (names.some((n) => ALLOWED_PROGRAMS.has(n))) {
    if (is('node') && !args.some((a) => !a.startsWith('-')) && !args.some((a) => /^(--version|-v|--test|--check|-c|--help|-h)$/.test(a))) found.unknown.push('node without a script file');
  } else {
    const pathy = /^[A-Za-z]:\\|\/|\\.*\\/.test(w[0]!.plain);
    found.unknown.push((pathy ? names[0] : names[names.length - 1]) || w[0]!.plain);
  }
  void manager;
}

/** Tier A and tier B for one shell command. */
export function checkShell(command: string, enforceAllowList: boolean = SHELL_ALLOW_LIST_ENFORCED): Decision {
  const { simples, substitution } = splitShell(command);
  const found: Found = { findings: [], unknown: [] };
  if (substitution) found.findings.push({ id: 'shell-substitution' });

  // Words split with quotes or backslashes that turn out to be key files: never.
  for (const s of simples) {
    for (const w of s.words) {
      if (!w.hadQuoteOrSlash) continue;
      const pieces = [w.bare, ...w.bare.split(/[=:,;<>]/), w.plain.replace(/["']/g, '')];
      if (pieces.some((p) => KEY_FILE.test(p))) {
        return { allow: false, reason: `Gatekeeper (shell-obfuscation): ${SHELL_RULES[0]!.reason}`, askJoshua: false };
      }
    }
  }

  for (const s of simples) {
    analyse(s.words, s.piped, found);
    for (const w of s.words) if (/^~(?:[\\/]|$)/.test(w.plain)) found.findings.push({ id: 'shell-outside-home' });
  }
  if (HOME_VARS.test(command)) found.findings.push({ id: 'shell-outside-home' });

  const first = found.findings[0];
  if (first) {
    const rule = SHELL_RULES.find((r) => r.id === first.id)!;
    return { allow: false, reason: `Gatekeeper (${rule.id}): ${first.detail ?? rule.reason}`, askJoshua: rule.askJoshua };
  }
  if (found.unknown.length) {
    const notes = [...new Set(found.unknown)].map((p) => `${p} isn't on the list of known build commands; it needs joshua's OK`);
    if (enforceAllowList) return { allow: false, reason: `Gatekeeper (${SHELL_ALLOW_LIST_RULE.id}): ${notes[0]}`, askJoshua: true };
    return { allow: true, note: notes.join('; ') };
  }
  return { allow: true };
}

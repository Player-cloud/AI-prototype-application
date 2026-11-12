/**
 * CI-7 (SUP-G): reads joshua's written instructions (rules, habits, project rules and tool cards)
 * for ones that are out of date or clash. It only flags, with the file and line each came from;
 * it never edits a file, and a flag is a "please check", not a verdict.
 *
 * Out of date:
 *  - a card written for one version of a tool when another version is in use;
 *  - a line naming a tool with a version ("secretlint 11") whose major version isn't the one in use;
 *  - a line telling the app to use a tool that is switched off or OFF in the ledger.
 * Clashing: a "never / don't / avoid …" line and another line about the same thing, or a card
 * whose "Use when" and "Don't use when" say the same thing.
 */

export interface DocLine { line: number; text: string }
/** One file's "- " lines (or a card's fields), each with its line number. */
export interface DocSource { file: string; lines: DocLine[] }

export interface DocTool {
  id: string;
  /** Names it goes by in writing (card title, ledger name, ID). */
  names: string[];
  /** Its card's file and the version the card was written for ('' when not written). */
  cardFile: string | null;
  cardVersion: string;
  /** The version in use (null when never seen). */
  inUse: string | null;
  /** Switched off after failures, or OFF / NOT NEEDED in the ledger. */
  off: boolean;
}

export type DocIssueKind = 'old' | 'clash';
export interface DocIssue { kind: DocIssueKind; file: string; line: number | null; text: string }

const NEG = /^(?:never|don['’]?t|do not|avoid|no longer|stop|not)\b\s*/i;
const STOP = new Set(
  'a an the to for in on of and or with it its is are be by as at use used using uses when any all this that these those your his joshua joshuas joshua’s from into than then so do does always must should please only also more less very just'.split(' '),
);

/** The words that carry meaning, lower case. */
export function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(NEG, '')
      .split(/[^a-z0-9.+#-]+/)
      .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

export function isNegative(text: string): boolean {
  return NEG.test(text.trim());
}

/** True when two lines are about the same thing: nearly the same words, or one inside the other. */
export function sameSubject(a: string, b: string): boolean {
  const x = contentWords(a);
  const y = contentWords(b);
  if (!x.size || !y.size) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  const small = Math.min(x.size, y.size);
  const jaccard = shared / (x.size + y.size - shared);
  return jaccard >= 0.75 || (shared === small && small >= 2);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const major = (v: string) => v.match(/\d+/)?.[0] ?? '';
const where = (i: DocIssue) => (i.line === null ? i.file : `${i.file} line ${i.line}`);

/** "rules.md line 3: …" */
export function docIssueText(i: DocIssue): string {
  return `${where(i)}: ${i.text}`;
}

const short = (t: string) => (t.length > 80 ? `${t.slice(0, 77)}…` : t);

export function checkDocs(sources: DocSource[], tools: DocTool[]): DocIssue[] {
  const out: DocIssue[] = [];

  for (const t of tools) {
    if (t.cardFile && t.cardVersion && t.inUse && t.cardVersion !== t.inUse) {
      out.push({ kind: 'old', file: t.cardFile, line: null, text: `written for version ${t.cardVersion}, but ${t.inUse} is in use. Check its advice still holds, then update its Version: line.` });
    }
  }

  for (const s of sources) {
    for (const l of s.lines) {
      for (const t of tools) {
        if (s.file === t.cardFile) continue; // a card names its own tool
        for (const name of t.names.filter((n) => n.length >= 4)) {
          const m = l.text.match(new RegExp(`(?:^|[^a-z0-9])${escape(name.toLowerCase())}\\s*v?(\\d+(?:\\.\\d+)*)?(?![a-z0-9])`, 'i'));
          if (!m) continue;
          if (m[1] && t.inUse && major(m[1]) !== major(t.inUse)) {
            out.push({ kind: 'old', file: s.file, line: l.line, text: `names ${name} ${m[1]}, but ${t.inUse} is in use: “${short(l.text)}”` });
          } else if (t.off && !isNegative(l.text)) {
            out.push({ kind: 'old', file: s.file, line: l.line, text: `relies on ${name}, which is switched off: “${short(l.text)}”` });
          }
          break;
        }
      }
    }
  }

  const all = sources.flatMap((s) => s.lines.filter((l) => !s.file.startsWith('tools/')).map((l) => ({ ...l, file: s.file })));
  for (const neg of all.filter((l) => isNegative(l.text))) {
    for (const pos of all.filter((l) => !isNegative(l.text))) {
      if (!sameSubject(neg.text, pos.text)) continue;
      out.push({ kind: 'clash', file: neg.file, line: neg.line, text: `“${short(neg.text)}” clashes with ${pos.file} line ${pos.line}: “${short(pos.text)}”` });
    }
  }

  for (const s of sources.filter((x) => x.file.startsWith('tools/'))) {
    const use = s.lines.find((l) => /^use when:/i.test(l.text));
    const dont = s.lines.find((l) => /^don['’]?t use when:/i.test(l.text));
    if (!use || !dont) continue;
    const u = use.text.replace(/^use when:\s*/i, '');
    const d = dont.text.replace(/^don['’]?t use when:\s*/i, '');
    if (sameSubject(u, d)) out.push({ kind: 'clash', file: s.file, line: dont.line, text: `“Use when” and “Don’t use when” say the same thing: “${short(u)}” / “${short(d)}”` });
  }

  const seen = new Set<string>();
  return out.filter((i) => {
    const k = docIssueText(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The numbered "- " lines of a Markdown file, comments removed. */
export function bulletLines(md: string): DocLine[] {
  const out: DocLine[] = [];
  md.split(/\r?\n/).forEach((l, i) => {
    if (l.startsWith('- ')) {
      const text = l.slice(2).replace(/<!--.*?-->/g, '').trim();
      if (text) out.push({ line: i + 1, text });
    }
  });
  return out;
}

/** A card's "Use when:" / "Don't use when:" / "What:" lines, numbered. */
export function cardLines(md: string): DocLine[] {
  const out: DocLine[] = [];
  md.split(/\r?\n/).forEach((l, i) => {
    if (/^(?:what|use when|don['’]?t use when):/i.test(l.trim())) out.push({ line: i + 1, text: l.trim() });
  });
  return out;
}

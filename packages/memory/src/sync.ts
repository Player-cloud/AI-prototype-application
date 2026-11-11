/**
 * Writes to the data repo and syncs it to GitHub with the computer's own git login.
 * Never forces anything: if GitHub has clashing changes, it stops and says so.
 * Before committing it looks for anything key-shaped, because keys must never reach GitHub.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Git = (args: string[], cwd: string) => Promise<string>;

export const realGit: Git = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });

/** Things that look like API keys or private keys. */
const KEY_SHAPES: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
];

export function looksLikeKey(text: string): boolean {
  return KEY_SHAPES.some((r) => r.test(text));
}

/** Changed paths from `git status --porcelain` (renames give the new path). */
export function changedFiles(porcelain: string): string[] {
  return porcelain
    .split(/\r?\n/)
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, ''));
}

export interface SyncResult {
  /** Local changes were committed. */
  committed: boolean;
  /** The repo was pushed to GitHub. */
  pushed: boolean;
  summary: string;
}

export async function syncDataRepo(folder: string, message: string, git: Git = realGit): Promise<SyncResult> {
  try {
    await git(['rev-parse', '--is-inside-work-tree'], folder);
  } catch {
    throw new Error(`${folder} is not a git clone of ai-prototype-data, so it can't sync.`);
  }

  const changed = changedFiles(await git(['status', '--porcelain'], folder));
  for (const f of changed) {
    let text = '';
    try {
      text = await readFile(join(folder, f), 'utf8');
    } catch {
      continue; // deleted files have nothing to scan
    }
    if (looksLikeKey(text)) {
      throw new Error(`Sync stopped: ${f} has something that looks like a key. Keys must never go to GitHub. Remove it and try again.`);
    }
  }

  if (changed.length > 0) {
    await git(['add', '-A'], folder);
    await git(['commit', '-q', '-m', message], folder);
  }

  try {
    await git(['pull', '--rebase', '-q'], folder);
  } catch {
    await git(['rebase', '--abort'], folder).catch(() => undefined);
    throw new Error(
      'Sync stopped: GitHub has changes that clash with this computer’s. Nothing was lost; the change is saved here and still needs merging.',
    );
  }
  await git(['push', '-q'], folder);
  const what = changed.length === 0 ? 'Nothing new to save.' : `Saved ${changed.length} file${changed.length === 1 ? '' : 's'}.`;
  return { committed: changed.length > 0, pushed: true, summary: `${what} Data repo is up to date on GitHub.` };
}

/**
 * Sets joshua's 1–5 rating on a tool's ledger line ("rating: x" at the end). Returns the new
 * ledger text, or throws if the tool isn't in the ledger.
 */
export function setRating(ledgerMd: string, tool: string, rating: number): string {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error('Rating must be a whole number from 1 to 5');
  let found = false;
  const lines = ledgerMd.split('\n').map((raw) => {
    // Keep Windows line endings as they are (git may check files out with \r\n).
    const cr = raw.endsWith('\r') ? '\r' : '';
    const line = cr ? raw.slice(0, -1) : raw;
    const parts = line.startsWith('- ') ? line.slice(2).split(' | ') : [];
    if (found || parts.length < 3 || parts[0]!.trim() !== tool) return raw;
    found = true;
    const last = parts.length - 1;
    if (/^\s*rating:/i.test(parts[last]!)) parts[last] = `rating: ${rating}`;
    else parts.push(`rating: ${rating}`);
    return `- ${parts.join(' | ')}${cr}`;
  });
  if (!found) throw new Error(`${tool} isn't in the ledger`);
  return lines.join('\n');
}

export async function rateTool(folder: string, tool: string, rating: number): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  const path = join(folder, 'ledger.md');
  const md = await readFile(path, 'utf8');
  await writeFile(path, setRating(md, tool, rating));
}

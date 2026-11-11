/**
 * Step 10a: the app talks to GitHub so joshua can follow and answer from his phone. It only uses
 * Issues, in the repo his data folder is cloned from (ai-prototype-data, private). The token is a
 * fine-grained one that can only read and write Issues there; it lives in the computer's password
 * store like the model keys, and the Rust shell hands it to the engine for each call.
 */
import type { AppSettings } from './settings.ts';

export type Fetch = typeof fetch;

const API = 'https://api.github.com';
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** "owner/name" from a GitHub remote URL (https or ssh), or null when it isn't GitHub. */
export function repoFromRemote(url: string): string | null {
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m && REPO.test(m[1]!) ? m[1]! : null;
}

/** The repo the app posts to: where the data folder is cloned from. */
export async function messagesRepo(settings: AppSettings): Promise<string> {
  if (!settings.dataFolder) throw new Error('Set the data folder in Settings first: phone messages go to the repo it’s cloned from.');
  const { realGit } = await import('@aip/memory');
  let url = '';
  try {
    url = await realGit(['remote', 'get-url', 'origin'], settings.dataFolder);
  } catch {
    throw new Error(`${settings.dataFolder} isn’t a git clone with a GitHub remote, so the app can’t post messages.`);
  }
  const repo = repoFromRemote(url);
  if (!repo) throw new Error('The data folder’s remote isn’t on GitHub, so the app can’t post messages.');
  return repo;
}

export interface Issue { number: number; title: string; state: 'open' | 'closed'; url: string; labels: string[] }
/** `role` is GitHub's author_association: OWNER, COLLABORATOR, MEMBER, NONE… */
export interface Comment { id: number; body: string; author: string; role: string; at: string }

interface RawIssue { number: number; title: string; state: 'open' | 'closed'; html_url: string; labels: ({ name: string } | string)[]; pull_request?: unknown }
interface RawComment { id: number; body: string | null; user: { login: string } | null; author_association?: string; created_at: string }
const toComment = (c: RawComment): Comment => ({ id: c.id, body: c.body ?? '', author: c.user?.login ?? '', role: c.author_association ?? 'NONE', at: c.created_at });

const toIssue = (r: RawIssue): Issue => ({
  number: r.number,
  title: r.title,
  state: r.state,
  url: r.html_url,
  labels: r.labels.map((l) => (typeof l === 'string' ? l : l.name)),
});

/** Plain words for GitHub's answers. The token is never put in a message. */
function problem(status: number, what: string): string {
  if (status === 401) return 'GitHub didn’t accept the token. Make a new one and save it in Settings.';
  if (status === 403) return `GitHub refused to ${what}: the token needs “Issues: Read and write” on the data repo, or GitHub’s rate limit was hit.`;
  if (status === 404) return `GitHub couldn’t find the data repo to ${what}. Check the token can see that repo.`;
  if (status === 410) return 'Issues are switched off on the data repo. Turn them on in its GitHub settings.';
  return `GitHub couldn’t ${what} (error ${status}).`;
}

export class GitHub {
  private readonly token: string;
  readonly repo: string;
  private readonly fetchImpl: Fetch;

  constructor(token: string, repo: string, fetchImpl: Fetch = fetch) {
    if (!REPO.test(repo)) throw new Error('repo must be owner/name');
    this.token = token;
    this.repo = repo;
    this.fetchImpl = fetchImpl;
  }

  private async call<T>(method: string, path: string, what: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${API}/repos/${this.repo}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'ai-prototype-application',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new Error(`Couldn’t reach GitHub to ${what}: ${(err as Error).message}`);
    }
    if (!res.ok) throw new Error(problem(res.status, what));
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** Free: reads the repo and its issues, so a token that can't see them is caught in Settings. */
  async check(): Promise<string> {
    const r = await this.call<{ full_name: string; private: boolean; has_issues: boolean }>('GET', '', 'read the data repo');
    if (!r.has_issues) throw new Error(problem(410, ''));
    await this.call('GET', '/issues?per_page=1', 'read issues');
    return `Connected. The app can read issues on ${r.full_name}${r.private ? ' (private)' : ''}. It posts there when a build finishes or needs you. This check is free.`;
  }

  async createIssue(title: string, body: string, labels: string[] = []): Promise<Issue> {
    return toIssue(await this.call<RawIssue>('POST', '/issues', 'post a message', { title, body, labels }));
  }

  async comment(issue: number, body: string): Promise<Comment> {
    const c = await this.call<RawComment>('POST', `/issues/${issue}/comments`, 'post a reply', { body });
    return toComment(c);
  }

  /** Comments after `since` (an ISO time), oldest first. */
  async comments(issue: number, since?: string): Promise<Comment[]> {
    const q = since ? `?per_page=100&since=${encodeURIComponent(since)}` : '?per_page=100';
    const list = await this.call<RawComment[]>('GET', `/issues/${issue}/comments${q}`, 'read replies');
    return list.map(toComment);
  }

  /** Open issues with a label (pull requests left out). */
  async openIssues(label: string): Promise<Issue[]> {
    const list = await this.call<RawIssue[]>('GET', `/issues?state=open&per_page=100&labels=${encodeURIComponent(label)}`, 'read messages');
    return list.filter((r) => !r.pull_request).map(toIssue);
  }

  async close(issue: number): Promise<void> {
    await this.call('PATCH', `/issues/${issue}`, 'close a message', { state: 'closed' });
  }
}

/** Settings → GitHub → Test connection. */
export async function githubCheck(token: string, settings: AppSettings, fetchImpl?: Fetch): Promise<{ ok: true; summary: string }> {
  const gh = new GitHub(token, await messagesRepo(settings), fetchImpl);
  return { ok: true, summary: await gh.check() };
}

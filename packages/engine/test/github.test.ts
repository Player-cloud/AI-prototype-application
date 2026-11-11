import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitHub, messagesRepo, repoFromRemote } from '../src/github.ts';
import { handleLine } from '../src/protocol.ts';
import { checkSettings } from '../src/settings.ts';

// Obviously fake test value, not a real token.
const TOKEN = 'github_pat_test_0000000000';

type Seen = { url: string; method: string; headers: Record<string, string>; body?: unknown };
function fakeFetch(answer: (s: Seen) => { status: number; json?: unknown }) {
  const seen: Seen[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const s: Seen = { url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(s);
    const a = answer(s);
    return new Response(a.json === undefined ? null : JSON.stringify(a.json), { status: a.status });
  }) as unknown as typeof fetch;
  return { f, seen };
}

describe('GitHub remote names', () => {
  it('reads owner/name from https and ssh remotes', () => {
    expect(repoFromRemote('https://github.com/Player-cloud/ai-prototype-data.git\n')).toBe('Player-cloud/ai-prototype-data');
    expect(repoFromRemote('https://github.com/Player-cloud/ai-prototype-data')).toBe('Player-cloud/ai-prototype-data');
    expect(repoFromRemote('git@github.com:Player-cloud/ai-prototype-data.git')).toBe('Player-cloud/ai-prototype-data');
    expect(repoFromRemote('ssh://git@github.com/Player-cloud/ai-prototype-data.git')).toBe('Player-cloud/ai-prototype-data');
  });
  it('refuses anything that isn’t GitHub', () => {
    expect(repoFromRemote('https://gitlab.com/a/b.git')).toBeNull();
    expect(repoFromRemote('https://github.com.evil.example/a/b')).toBeNull();
    expect(repoFromRemote('/home/joshua/data.git')).toBeNull();
  });
});

describe('the data folder’s repo', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aip-gh-'));
    execFileSync('git', ['init', '-q', dir]);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it('explains what’s missing in plain words', async () => {
    await expect(messagesRepo(checkSettings({}))).rejects.toThrow('Set the data folder in Settings first');
    await expect(messagesRepo(checkSettings({ dataFolder: dir }))).rejects.toThrow('isn’t a git clone with a GitHub remote');
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/Player-cloud/ai-prototype-data.git'], { cwd: dir });
    expect(await messagesRepo(checkSettings({ dataFolder: dir }))).toBe('Player-cloud/ai-prototype-data');
  });

  it('github_check reads the repo and its issues, and never echoes the token', async () => {
    const { f, seen } = fakeFetch((s) => (s.url.endsWith('/issues?per_page=1') ? { status: 200, json: [] } : { status: 200, json: { full_name: 'Player-cloud/ai-prototype-data', private: true, has_issues: true } }));
    const reply = await handleLine(JSON.stringify({ id: 1, method: 'github_check', params: { token: TOKEN, settings: { dataFolder: dir } } }), { fetch: f } as never);
    expect(JSON.parse(reply).result.summary).toBe('Connected. The app can read issues on Player-cloud/ai-prototype-data (private). It posts there when a build finishes or needs you. This check is free.');
    expect(reply).not.toContain(TOKEN);
    expect(seen.map((s) => [s.method, s.url])).toEqual([
      ['GET', 'https://api.github.com/repos/Player-cloud/ai-prototype-data'],
      ['GET', 'https://api.github.com/repos/Player-cloud/ai-prototype-data/issues?per_page=1'],
    ]);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('turns GitHub refusals into plain words without the token', async () => {
    for (const [status, says] of [
      [401, 'GitHub didn’t accept the token'],
      [403, 'needs “Issues: Read and write”'],
      [404, 'couldn’t find the data repo'],
    ] as const) {
      const { f } = fakeFetch(() => ({ status }));
      const reply = await handleLine(JSON.stringify({ id: 1, method: 'github_check', params: { token: TOKEN, settings: { dataFolder: dir } } }), { fetch: f } as never);
      expect(JSON.parse(reply).error).toContain(says);
      expect(reply).not.toContain(TOKEN);
    }
  });
});

describe('issues', () => {
  it('posts, replies, reads replies, lists and closes', async () => {
    const { f, seen } = fakeFetch((s) => {
      if (s.method === 'POST' && s.url.endsWith('/issues')) return { status: 201, json: { number: 7, title: 'F-01 built', state: 'open', html_url: 'https://github.com/o/r/issues/7', labels: [{ name: 'aip' }] } };
      if (s.method === 'POST') return { status: 201, json: { id: 1, body: 'ok', user: { login: 'aip' }, created_at: '2026-11-11T20:00:00Z' } };
      if (s.method === 'PATCH') return { status: 200, json: {} };
      if (s.url.includes('/comments')) return { status: 200, json: [{ id: 2, body: 'keep', user: { login: 'joshua' }, author_association: 'OWNER', created_at: '2026-11-11T20:01:00Z' }] };
      return { status: 200, json: [{ number: 7, title: 'F-01 built', state: 'open', html_url: 'u', labels: ['aip'] }, { number: 8, title: 'a PR', state: 'open', html_url: 'u', labels: [], pull_request: {} }] };
    });
    const gh = new GitHub(TOKEN, 'o/r', f);
    expect(await gh.createIssue('F-01 built', 'Keep or Undo?', ['aip'])).toEqual({ number: 7, title: 'F-01 built', state: 'open', url: 'https://github.com/o/r/issues/7', labels: ['aip'] });
    expect(seen[0]!.body).toEqual({ title: 'F-01 built', body: 'Keep or Undo?', labels: ['aip'] });
    await gh.comment(7, 'ok');
    expect(await gh.comments(7, '2026-11-11T20:00:00Z')).toEqual([{ id: 2, body: 'keep', author: 'joshua', role: 'OWNER', at: '2026-11-11T20:01:00Z' }]);
    expect(seen[2]!.url).toBe('https://api.github.com/repos/o/r/issues/7/comments?per_page=100&since=2026-11-11T20%3A00%3A00Z');
    expect((await gh.openIssues('aip')).map((i) => i.number)).toEqual([7]);
    await gh.close(7);
    expect(seen.at(-1)).toMatchObject({ method: 'PATCH', url: 'https://api.github.com/repos/o/r/issues/7', body: { state: 'closed' } });
  });

  it('says when GitHub can’t be reached', async () => {
    const f = (async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    }) as unknown as typeof fetch;
    await expect(new GitHub(TOKEN, 'o/r', f).openIssues('aip')).rejects.toThrow('Couldn’t reach GitHub to read messages: getaddrinfo ENOTFOUND api.github.com');
  });
});

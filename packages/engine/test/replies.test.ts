import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunLog, WorkItems } from '@aip/memory';
import { handleLine } from '../src/protocol.ts';
import { parseReply } from '../src/replies.ts';

const NOW = new Date('2026-11-11T20:00:00Z');
// Obviously fake test value, not a real token.
const TOKEN = 'github_pat_test_0000000000';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });

describe('reading a reply', () => {
  it('understands keep, undo and a 1–5 rating, from the first line only', () => {
    expect(parseReply('Keep')).toEqual({ kind: 'keep' });
    expect(parseReply(' keep it!\nLooks good.')).toEqual({ kind: 'keep' });
    expect(parseReply('UNDO.')).toEqual({ kind: 'undo' });
    expect(parseReply('4')).toEqual({ kind: 'rate', rating: 4 });
    expect(parseReply('rate 5')).toEqual({ kind: 'rate', rating: 5 });
    expect(parseReply('3/5')).toEqual({ kind: 'rate', rating: 3 });
    expect(parseReply('6')).toEqual({ kind: 'unknown' });
    expect(parseReply('please keep the old one')).toEqual({ kind: 'unknown' });
  });
});

describe('replies from the phone', () => {
  let root = '';
  let code = '';
  let data = '';
  let db = '';
  let comments: { id: number; body: string; user: { login: string }; author_association: string; created_at: string }[] = [];
  let posted: { url: string; method: string; body?: { body?: string } }[] = [];

  const fakeFetch = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    if (method === 'GET') return new Response(JSON.stringify(comments), { status: 200 });
    posted.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ id: 99, body: '', user: { login: 'joshua' }, created_at: '2026-11-11T20:05:00Z' }), { status: method === 'PATCH' ? 200 : 201 });
  }) as unknown as typeof fetch;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'aip-replies-')));
    code = join(root, 'club-hr');
    data = join(root, 'data');
    db = join(root, 'history.sqlite');
    comments = [];
    posted = [];
    execFileSync('git', ['init', '-q', '-b', 'main', code]);
    git(code, 'config', 'user.name', 'Test');
    git(code, 'config', 'user.email', 'test@example.invalid');
    git(code, 'config', 'commit.gpgsign', 'false');
    git(code, 'config', 'core.autocrlf', 'false');
    await writeFile(join(code, 'README.md'), '# Club HR\n');
    git(code, 'add', '.');
    git(code, 'commit', '-q', '-m', 'first');
    execFileSync('git', ['init', '-q', data]);
    git(data, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A finished build, waiting, posted as issue #12. */
  async function waiting() {
    const branch = 'aip/f-01-20261111-193000';
    const path = join(root, 'club-hr-runs', 'F-01-20261111-193000');
    git(code, 'worktree', 'add', '-q', '-b', branch, path, 'HEAD');
    await writeFile(join(path, 'F-01.md'), 'F-01 page\n');
    const log = RunLog.open(db);
    const id = log.add({ at: NOW, slug: 'club-hr', feature: 'F-01', path, branch, base: git(code, 'rev-parse', 'HEAD').trim(), model: 'claude-sonnet-5-5', costUsd: 0.42, testsPassed: true, fixAttempts: 0, summary: 'Added it.' });
    log.close();
    const w = WorkItems.open(db);
    w.posted(w.add(NOW, 'build', id, 'club-hr F-01: built, waiting for Keep or Undo'), 12, 'https://github.com/o/r/issues/12', NOW);
    w.close();
    return id;
  }

  const reply = (id: number, body: string, at: string, role = 'OWNER') => comments.push({ id, body, user: { login: 'joshua' }, author_association: role, created_at: at });
  const poll = async () =>
    JSON.parse(
      await handleLine(JSON.stringify({ id: 1, method: 'work_poll', params: { settings: { codeFolders: { 'club-hr': code }, dataFolder: data }, dbPath: db, githubToken: TOKEN } }), {
        now: () => NOW,
        fetch: fakeFetch,
        modelName: async () => 'Sonnet',
      } as never),
    );

  it('rates, then keeps, from the phone, and answers on the issue', async () => {
    const id = await waiting();
    reply(1, '4', '2026-11-11T20:01:00Z');
    let r = (await poll()).result;
    expect(r).toEqual({ done: ['From your phone (issue #12): Rated F-01 4/5.'], changed: true });
    expect(posted[0]).toMatchObject({ method: 'POST', url: 'https://api.github.com/repos/o/r/issues/12/comments' });
    expect(posted[0]!.body!.body).toContain('Rated F-01 4/5.');

    // The same reply isn't acted on twice, and the app's own answer is ignored.
    reply(99, 'Rated F-01 4/5.\n\n_Posted by AI Prototype._', '2026-11-11T20:01:30Z');
    expect((await poll()).result).toEqual({ done: [], changed: false });

    reply(2, 'keep', '2026-11-11T20:02:00Z');
    r = (await poll()).result;
    expect(r.done).toEqual(['From your phone (issue #12): Kept F-01 in your copy on main. Nothing was pushed.']);
    expect(await readFile(join(code, 'F-01.md'), 'utf8')).toBe('F-01 page\n');
    expect(posted.at(-1)).toMatchObject({ method: 'PATCH', url: 'https://api.github.com/repos/o/r/issues/12' });
    const log = RunLog.open(db);
    expect(log.get(id)).toMatchObject({ status: 'kept', rating: 4 });
    log.close();
    expect((await handleLine(JSON.stringify({ id: 1, method: 'work_list', params: { dbPath: db } }))).includes('"result":[]')).toBe(true);
  });

  it('says why a phone Keep was refused, and keeps the item open', async () => {
    await waiting();
    await writeFile(join(code, 'README.md'), '# changed, not committed\n');
    reply(1, 'keep', '2026-11-11T20:01:00Z');
    const r = (await poll()).result;
    expect(r.done[0]).toContain('has changes not committed yet');
    expect(posted.map((p) => p.method)).toEqual(['POST']);
    const w = WorkItems.open(db);
    expect(w.listOpen()).toHaveLength(1);
    w.close();
  });

  it('ignores people without access, and asks again when it doesn’t understand', async () => {
    await waiting();
    reply(1, 'undo', '2026-11-11T20:01:00Z', 'NONE');
    reply(2, 'what is this?', '2026-11-11T20:02:00Z');
    const r = (await poll()).result;
    expect(r).toEqual({ done: ['From your phone (issue #12): Sorry, I didn’t understand that. Reply **keep**, **undo**, or a rating from **1** to **5**.'], changed: false });
  });

  it('does nothing without a token', async () => {
    await waiting();
    reply(1, 'undo', '2026-11-11T20:01:00Z');
    const r = JSON.parse(await handleLine(JSON.stringify({ id: 1, method: 'work_poll', params: { settings: {}, dbPath: db } }), { fetch: fakeFetch } as never)).result;
    expect(r).toEqual({ done: [], changed: false });
    expect(posted).toEqual([]);
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpendLog, WorkItems } from '@aip/memory';
import { handleLine } from '../src/protocol.ts';
import { CONTROL_LABEL, parseCommand } from '../src/phone.ts';

const NOW = new Date('2026-11-12T12:00:00Z');
// Obviously fake test value, not a real token.
const TOKEN = 'github_pat_test_0000000000';

describe('phone commands (D)', () => {
  it('reads the first line only, and nothing else counts', () => {
    expect(parseCommand('build club-hr F-02')).toEqual({ kind: 'build', project: 'club-hr', feature: 'F-02' });
    expect(parseCommand('Build Club HR f-12.\nthanks')).toEqual({ kind: 'build', project: 'Club HR', feature: 'F-12' });
    expect(parseCommand('projects')).toEqual({ kind: 'projects' });
    expect(parseCommand('HELP')).toEqual({ kind: 'help' });
    expect(parseCommand('build club-hr')).toEqual({ kind: 'unknown' });
    expect(parseCommand('please build club-hr F-02')).toEqual({ kind: 'unknown' });
    expect(parseCommand('build club-hr F-02; rm -rf /')).toEqual({ kind: 'unknown' });
  });
});

describe('starting a build from the phone (D)', () => {
  let root = '';
  let data = '';
  let db = '';
  let comments: { id: number; body: string; user: { login: string }; author_association: string; created_at: string }[] = [];
  let posted: { url: string; method: string; body?: { body?: string; title?: string; labels?: string[] } }[] = [];

  const fakeFetch = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    if (method === 'GET') return new Response(JSON.stringify(comments), { status: 200 });
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    posted.push({ url, method, body });
    if (url.endsWith('/issues')) return new Response(JSON.stringify({ number: 5, html_url: 'https://github.com/o/r/issues/5', title: body.title, state: 'open', labels: body.labels }), { status: 201 });
    return new Response(JSON.stringify({ id: 99, body: '', user: { login: 'joshua' }, created_at: '2026-11-12T12:05:00Z' }), { status: 201 });
  }) as unknown as typeof fetch;

  const call = async (method: string, params: Record<string, unknown>) =>
    JSON.parse(await handleLine(JSON.stringify({ id: 1, method, params }), { now: () => NOW, fetch: fakeFetch, modelName: async () => 'Sonnet' } as never));

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'aip-phone-')));
    data = join(root, 'data');
    db = join(root, 'history.sqlite');
    await mkdir(data);
    execFileSync('git', ['init', '-q', data]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], { cwd: data });
    comments = [];
    posted = [];
    const settings = { dataFolder: data };
    await call('interview_start', { settings, name: 'Club HR' });
    const patches: Record<string, Record<string, unknown>> = {
      idea: { text: { 'idea.what': 'HR' } },
      audience: { text: { 'audience.who': 'Staff', 'audience.goals': 'Shifts' } },
      features: { features: [{ name: 'Login' }, { name: 'Rota' }] },
      checklist: { areas: [] },
      look: { text: { 'look.feel': 'Calm' } },
      tech: {},
      done: { done: { 'F-01': ['Works'], 'F-02': ['Works'] } },
    };
    for (const [stage, patch] of Object.entries(patches)) {
      await call('interview_save', { settings, slug: 'club-hr', stage, patch });
      await call('interview_confirm', { settings, slug: 'club-hr', stage });
    }
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const reply = (id: number, body: string, at: string, role = 'OWNER') => comments.push({ id, body, user: { login: 'joshua' }, author_association: role, created_at: at });
  const settings = () => ({ dataFolder: data, codeFolders: { 'club-hr': join(root, 'club-hr') }, runCapGbp: 0.8, gbpPerUsd: 0.79 });
  const poll = async (busy = false) => (await call('work_poll', { settings: settings(), dbPath: db, githubToken: TOKEN, busy })).result;

  it('sets up the issue once, and keeps it out of “Needs you”', async () => {
    const first = (await call('phone_setup', { settings: settings(), dbPath: db, githubToken: TOKEN })).result;
    expect(first).toMatchObject({ issue: 5, url: 'https://github.com/o/r/issues/5' });
    expect(first.summary).toMatch(/^Set up: issue #5 on o\/r\./);
    expect(posted[0]!.body).toMatchObject({ title: 'AI Prototype: start builds from here', labels: [CONTROL_LABEL] });
    expect(posted[0]!.body!.body).toContain('**build** *project* *feature*');
    const again = (await call('phone_setup', { settings: settings(), dbPath: db, githubToken: TOKEN })).result;
    expect(again.summary).toBe('Already set up: issue #5. Reply there from your phone.');
    expect(posted).toHaveLength(1);
    expect((await call('work_list', { dbPath: db })).result).toEqual([]);
    expect((await call('phone_setup', { settings: settings(), dbPath: db })).error).toMatch(/^Add a GitHub token in Settings first/);
  });

  it('lists projects, then starts a checked build, saying the most it can cost', async () => {
    await call('phone_setup', { settings: settings(), dbPath: db, githubToken: TOKEN });
    reply(1, 'projects', '2026-11-12T12:01:00Z');
    let r = await poll();
    expect(r.builds).toEqual([]);
    expect(posted.at(-1)!.body!.body).toContain('**Club HR** (`club-hr`): F-01 Login, F-02 Rota');

    reply(2, 'build Club HR F-02', '2026-11-12T12:02:00Z');
    r = await poll();
    expect(r.builds).toEqual([{ slug: 'club-hr', feature: 'F-02', issue: 5 }]);
    expect(r.done).toEqual(['From your phone (issue #5): Starting F-02 Rota in Club HR. It costs up to £0.80 ($1.01). The result comes as a new issue.']);
    // Not acted on twice.
    expect((await poll()).builds).toEqual([]);
  });

  it('refuses plainly: busy, unknown project or feature, no code folder, budget used up, people without access', async () => {
    await call('phone_setup', { settings: settings(), dbPath: db, githubToken: TOKEN });
    reply(1, 'build club-hr F-01', '2026-11-12T12:01:00Z');
    expect((await poll(true)).done).toEqual(['From your phone (issue #5): A build is already running. Try again when it’s finished.']);
    reply(2, 'build shop F-01', '2026-11-12T12:02:00Z');
    reply(3, 'build club-hr F-09', '2026-11-12T12:03:00Z');
    reply(4, 'build club-hr F-01', '2026-11-12T12:04:00Z', 'NONE');
    reply(5, 'hello', '2026-11-12T12:05:00Z');
    let r = await poll();
    expect(r.builds).toEqual([]);
    expect(r.done).toEqual([
      'From your phone (issue #5): There’s no finished plan called “shop”. Reply **projects** to see them.',
      'From your phone (issue #5): Club HR has no feature F-09. Reply **projects** to see them.',
      'From your phone (issue #5): Sorry, I didn’t understand that.',
    ]);
    reply(6, 'build club-hr F-01', '2026-11-12T12:06:00Z');
    r = (await call('work_poll', { settings: { dataFolder: data }, dbPath: db, githubToken: TOKEN })).result;
    expect(r.done).toEqual(['From your phone (issue #5): Club HR has no code folder on this computer yet. Set it on the PC first.']);
    const spend = SpendLog.open(db);
    spend.record({ at: NOW, provider: 'claude', model: 'claude-sonnet-5-5', job: 'build', inputTokens: 1, outputTokens: 1, costUsd: 100 });
    spend.close();
    reply(7, 'build club-hr F-01', '2026-11-12T12:07:00Z');
    r = await poll();
    expect(r.done[0]).toMatch(/^From your phone \(issue #5\): This month’s budget is used up/);
    expect(r.builds).toEqual([]);
  });

  it('starts only one build per look, even if asked twice', async () => {
    await call('phone_setup', { settings: settings(), dbPath: db, githubToken: TOKEN });
    reply(1, 'build club-hr F-01', '2026-11-12T12:01:00Z');
    reply(2, 'build club-hr F-02', '2026-11-12T12:02:00Z');
    const r = await poll();
    expect(r.builds).toEqual([{ slug: 'club-hr', feature: 'F-01', issue: 5 }]);
    expect(r.done[1]).toBe('From your phone (issue #5): A build is already running. Try again when it’s finished.');
    const w = WorkItems.open(db);
    expect(w.control()).toMatchObject({ kind: 'control', issue: 5, readUpTo: '2026-11-12T12:02:00Z' });
    w.close();
  });
});

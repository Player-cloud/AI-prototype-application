import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunLog, WorkItems } from '@aip/memory';
import { MAX_QUESTIONS, answersFor, parseAnswer, questionsIn, saveAnswer, shortenKeepingQuestions } from '../src/questions.ts';
import { buildBody, publishPictures } from '../src/notify.ts';
import { buildPrompt } from '../src/build.ts';
import { checkSettings } from '../src/settings.ts';
import { handleLine } from '../src/protocol.ts';

const NOW = new Date('2026-11-12T12:00:00Z');
// Obviously fake test value, not a real token.
const TOKEN = 'github_pat_test_0000000000';
const SUMMARY = 'Added the rota page. Tests pass.\n\n**Questions for joshua:**\n- Should weeks start on Monday? I used Monday.\n2. Show part-time staff? I showed them.\n\nThanks.';

describe('the model’s questions (D)', () => {
  it('finds the questions at the end of the summary, and nothing else', () => {
    expect(questionsIn(SUMMARY)).toEqual(['Should weeks start on Monday? I used Monday.', 'Show part-time staff? I showed them.']);
    expect(questionsIn('Added it. I had no questions for joshua.')).toEqual([]);
    expect(questionsIn(`Questions for joshua:\n${Array.from({ length: 8 }, (_, i) => `- Q${i}`).join('\n')}`)).toHaveLength(MAX_QUESTIONS);
    // New summaries say "Questions for the user:"; older ones said "Questions for joshua:". Both are read.
    expect(questionsIn('Done.\n\nQuestions for the user:\n- Dark mode? I left it out.')).toEqual(['Dark mode? I left it out.']);
    expect(buildPrompt({ name: 'Club HR', features: [{ id: 'F-01', name: 'Login', what: '' }] } as never, 'F-01', 'spec')).toContain('Questions for the user:');
  });

  it('keeps the questions when a long summary is shortened', () => {
    const long = `${'x'.repeat(3000)}\n\nQuestions for joshua:\n- Keep this one?`;
    const short = shortenKeepingQuestions(long, 2000);
    expect(short.length).toBeLessThanOrEqual(2000);
    expect(questionsIn(short)).toEqual(['Keep this one?']);
    expect(shortenKeepingQuestions('short', 2000)).toBe('short');
  });

  it('reads an answer from the whole reply; “answer:” is question 1', () => {
    expect(parseAnswer('answer 2: no, full-time only')).toEqual({ n: 2, text: 'no, full-time only' });
    expect(parseAnswer('Answer: Monday.\nAnd show the week number.')).toEqual({ n: 1, text: 'Monday.\nAnd show the week number.' });
    expect(parseAnswer('keep')).toBeNull();
    expect(parseAnswer('answer 1:   ')).toBeNull();
  });

  it('puts the questions and pictures in the build’s issue', () => {
    const body = buildBody({
      slug: 'club-hr',
      feature: 'F-02',
      testsPassed: true,
      fixAttempts: 0,
      blocking: [],
      advice: [],
      costText: '£0.33 ($0.42)',
      screensChanged: true,
      summary: SUMMARY,
      questions: questionsIn(SUMMARY),
      pictures: [{ name: 'desktop', url: 'https://github.com/o/r/blob/HEAD/pictures/club-hr/7-desktop.png?raw=true' }],
    });
    expect(body).toContain('![desktop](https://github.com/o/r/blob/HEAD/pictures/club-hr/7-desktop.png?raw=true)');
    expect(body).toContain('1. Should weeks start on Monday? I used Monday.\n2. Show part-time staff? I showed them.');
    expect(body).toContain('reply **answer 1:** and your answer');
    expect(buildBody({ slug: 's', feature: 'F-01', testsPassed: true, fixAttempts: 0, blocking: [], advice: [], costText: '', screensChanged: null, summary: 'x', picturesNote: 'on your PC only for now: no network' })).toContain('Pictures: on your PC only for now: no network');
  });
});

describe('answers and pictures on the data repo (D)', () => {
  let root = '';
  let data = '';
  let remote = '';
  let db = '';
  let comments: { id: number; body: string; user: { login: string }; author_association: string; created_at: string }[] = [];
  let posted: { url: string; method: string; body?: { body?: string } }[] = [];
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });

  const fakeFetch = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    if (method === 'GET') return new Response(JSON.stringify(comments), { status: 200 });
    posted.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ id: 99, body: '', user: { login: 'joshua' }, created_at: '2026-11-12T12:05:00Z' }), { status: 201 });
  }) as unknown as typeof fetch;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'aip-questions-')));
    remote = join(root, 'remote.git');
    data = join(root, 'data');
    db = join(root, 'history.sqlite');
    comments = [];
    posted = [];
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    execFileSync('git', ['clone', '-q', remote, data], { stdio: 'pipe' });
    git(data, 'config', 'user.name', 'Test');
    git(data, 'config', 'user.email', 'test@example.invalid');
    git(data, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(data, 'ledger.md'), '# ledger\n');
    git(data, 'add', '.');
    git(data, 'commit', '-q', '-m', 'first');
    git(data, 'push', '-q', '-u', 'origin', 'main');
    // The data repo names GitHub; git is pointed at a local copy instead, so nothing leaves this computer.
    git(data, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
    git(data, 'config', `url.${remote}.insteadOf`, 'https://github.com/o/r.git');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('saves answers for the project and gives them to its later builds only', async () => {
    const settings = checkSettings({ dataFolder: data });
    expect(await answersFor(settings, 'club-hr')).toBe('');
    await mkdir(join(data, 'projects', 'club-hr'), { recursive: true });
    const note = await saveAnswer(settings, 'club-hr', 'F-02', 'Should weeks start on Monday?', 'Yes,\nMonday.', NOW);
    expect(note).toMatch(/^Saved for the next build of this project/);
    const file = await readFile(join(data, 'projects', 'club-hr', 'answers.md'), 'utf8');
    expect(file).toContain('- 2026-11-12, F-02: Should weeks start on Monday? **Answer:** Yes, Monday.');
    expect(await answersFor(settings, 'club-hr')).toContain('The user’s answers to earlier questions on this project (follow them):');
    expect(await answersFor(settings, 'other')).toBe('');
    await expect(saveAnswer(settings, 'club-hr', 'F-02', 'Q', `ghp_${'a1'.repeat(18)}`, NOW)).rejects.toThrow(/looks like it has a key/);
  });

  it('answers a question from the phone, and says plainly when there’s no such question', async () => {
    const log = RunLog.open(db);
    const id = log.add({ at: NOW, slug: 'club-hr', feature: 'F-02', path: '/x', branch: 'b', base: 'c', model: 'm', costUsd: 0.1, testsPassed: true, fixAttempts: 0, summary: SUMMARY });
    log.close();
    const w = WorkItems.open(db);
    w.posted(w.add(NOW, 'build', id, 'club-hr F-02: built'), 12, 'https://github.com/o/r/issues/12', NOW);
    w.close();
    comments.push({ id: 1, body: 'answer 2: full-time only', user: { login: 'joshua' }, author_association: 'OWNER', created_at: '2026-11-12T12:01:00Z' });
    comments.push({ id: 2, body: 'answer 3: what?', user: { login: 'joshua' }, author_association: 'OWNER', created_at: '2026-11-12T12:02:00Z' });
    const r = JSON.parse(
      await handleLine(JSON.stringify({ id: 1, method: 'work_poll', params: { settings: { dataFolder: data }, dbPath: db, githubToken: TOKEN } }), {
        now: () => NOW,
        fetch: fakeFetch,
        modelName: async () => 'Sonnet',
      } as never),
    ).result;
    expect(r.done).toEqual(['From your phone (issue #12): Answer 2 Saved for the next build of this project.', 'From your phone (issue #12): There’s no question 3: this build asked 2.']);
    expect(r.changed).toBe(false);
    expect(await readFile(join(data, 'projects', 'club-hr', 'answers.md'), 'utf8')).toContain('Show part-time staff? I showed them. **Answer:** full-time only');
    // The build is still waiting for Keep or Undo.
    expect((await handleLine(JSON.stringify({ id: 1, method: 'work_list', params: { dbPath: db } }))).includes('"runId":1')).toBe(true);
  });

  it('puts pictures on the data repo and links them for the issue', async () => {
    const shots = join(root, 'shots');
    await mkdir(shots);
    await writeFile(join(shots, 'desktop.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(shots, 'bad.png'), 'x');
    const settings = checkSettings({ dataFolder: data });
    const r = await publishPictures(settings, 'club-hr', 7, [
      { name: 'desktop', path: join(shots, 'desktop.png') },
      { name: '../evil', path: join(shots, 'bad.png') },
    ]);
    expect(r).toEqual({ links: [{ name: 'desktop', url: 'https://github.com/o/r/blob/HEAD/pictures/club-hr/7-desktop.png?raw=true' }], note: '' });
    expect(git(data, 'log', '-1', '--format=%s')).toBe('Pictures for club-hr build 7\n');
    expect(await publishPictures(checkSettings({}), 'club-hr', 7, [{ name: 'desktop', path: join(shots, 'desktop.png') }])).toEqual({ links: [], note: 'on your PC only (no data folder set).' });
  });
});

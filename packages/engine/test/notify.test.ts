import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBody, buildTitle, closeBuild, postBuild, type BuildNews } from '../src/notify.ts';
import { handleLine } from '../src/protocol.ts';
import { checkSettings } from '../src/settings.ts';

const NOW = new Date('2026-11-11T20:00:00Z');
// Obviously fake test value, not a real token.
const TOKEN = 'github_pat_test_0000000000';

const NEWS: BuildNews = {
  slug: 'club-hr',
  feature: 'F-02',
  testsPassed: true,
  fixAttempts: 1,
  blocking: [],
  advice: ['axe'],
  costText: '£0.33 ($0.42)',
  screensChanged: true,
  summary: 'Added the rota page.\nTests pass.',
};

type Seen = { url: string; method: string; body?: Record<string, unknown> };
function fakeGitHub(status = 201) {
  const seen: Seen[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const s: Seen = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(s);
    if (status >= 400) return new Response(null, { status });
    const json = s.url.endsWith('/issues') ? { number: 12, title: 't', state: 'open', html_url: 'https://github.com/o/r/issues/12', labels: [] } : { id: 1, body: '', user: { login: 'x' }, created_at: '' };
    return new Response(JSON.stringify(json), { status: s.method === 'PATCH' ? 200 : 201 });
  }) as unknown as typeof fetch;
  return { f, seen };
}

describe('phone messages for builds', () => {
  let root = '';
  let data = '';
  let db = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aip-notify-'));
    data = join(root, 'data');
    db = join(root, 'history.sqlite');
    execFileSync('git', ['init', '-q', data]);
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:o/r.git'], { cwd: data });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const work = async () => JSON.parse(await handleLine(JSON.stringify({ id: 1, method: 'work_list', params: { dbPath: db } }))).result;

  it('says in plain words what the build needs and what it cost', () => {
    expect(buildTitle(NEWS)).toBe('club-hr F-02: built, waiting for Keep or Undo');
    expect(buildTitle({ ...NEWS, testsPassed: false })).toBe('club-hr F-02: built, but it can’t be kept: Undo it');
    expect(buildTitle({ ...NEWS, blocking: ['secrets'] })).toBe('club-hr F-02: built, but it can’t be kept: Undo it');
    const body = buildBody(NEWS);
    expect(body).toContain('- Tests: pass (1 fix attempt)');
    expect(body).toContain('- Checks: nothing blocks Keep; see notes on axe');
    expect(body).toContain('- Cost: £0.33 ($0.42)');
    expect(body).toContain('- Screens: changed since the last build');
    expect(body).toContain('What the model says it did (its own words, not checked by the app):\n\n> Added the rota page.\n> Tests pass.');
    expect(body).not.toContain('What the app found');
    // V2 B: the model's claims, beside what the app found.
    const withClaims = buildBody({ ...NEWS, claims: ['✓ Tests: The app checked this itself: passed.', '? Lint: The app doesn’t check this itself, so only the model says so.'] });
    expect(withClaims).toContain(
      'What the app found about those claims:\n\n- ✓ Tests: The app checked this itself: passed.\n- ? Lint: The app doesn’t check this itself, so only the model says so.',
    );
  });

  it('posts an issue, lists it under Needs you, and closes both after Keep', async () => {
    const settings = checkSettings({ dataFolder: data });
    const gh = fakeGitHub();
    expect(await postBuild(settings, db, 7, NEWS, TOKEN, NOW, gh.f)).toBe('Sent to your phone: issue #12 on o/r.');
    expect(gh.seen[0]).toMatchObject({ method: 'POST', url: 'https://api.github.com/repos/o/r/issues', body: { title: 'club-hr F-02: built, waiting for Keep or Undo' } });
    expect(await work()).toMatchObject([{ runId: 7, issue: 12, title: 'club-hr F-02: built, waiting for Keep or Undo' }]);

    expect(await closeBuild(settings, db, 7, 'Kept F-02 in your copy on main.', TOKEN, NOW, gh.f)).toBe('Closed issue #12 on your phone.');
    expect(gh.seen.slice(1).map((s) => [s.method, s.url])).toEqual([
      ['POST', 'https://api.github.com/repos/o/r/issues/12/comments'],
      ['PATCH', 'https://api.github.com/repos/o/r/issues/12'],
    ]);
    expect(String(gh.seen[1]!.body!.body)).toContain('Kept F-02 in your copy on main.');
    expect(await work()).toEqual([]);
  });

  it('still lists the item without a token, and says how to get it on the phone', async () => {
    const settings = checkSettings({ dataFolder: data });
    expect(await postBuild(settings, db, 7, NEWS, undefined, NOW)).toBe('Not sent to your phone: add a GitHub token in Settings for that.');
    expect(await work()).toMatchObject([{ runId: 7, issue: 0 }]);
    expect(await closeBuild(settings, db, 7, 'Undone.', undefined, NOW)).toBe('');
    expect(await work()).toEqual([]);
  });

  it('never stops for GitHub problems, and never posts a key-shaped summary', async () => {
    const settings = checkSettings({ dataFolder: data });
    expect(await postBuild(settings, db, 7, NEWS, TOKEN, NOW, fakeGitHub(401).f)).toBe('Couldn’t message your phone: GitHub didn’t accept the token. Make a new one and save it in Settings.');
    const gh = fakeGitHub();
    const leaky = { ...NEWS, summary: `Used key ${'sk-ant-'}api03-${'x'.repeat(40)}` };
    expect(await postBuild(settings, db, 8, leaky, TOKEN, NOW, gh.f)).toBe('Not sent to your phone: the build’s summary has something that looks like a key.');
    expect(gh.seen).toEqual([]);
    expect((await work()).map((w: { runId: number }) => w.runId)).toEqual([7, 8]);
  });
});

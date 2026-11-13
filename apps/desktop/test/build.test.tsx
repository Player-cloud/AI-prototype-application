// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Build, limitText } from '../src/screens/Build';
import { doneList } from '../src/build';
import type { BuildEvent, Finding, MakeChannel } from '../src/build';
import type { Invoke } from '../src/engine';
import { routeEngine } from './shell';

afterEach(cleanup);

const RUN = { path: '/code/club-hr-runs/F-02-20261111-170000', branch: 'aip/f-02-20261111-170000', feature: 'F-02', base: 'abc' };

/** Stand-in for the shell: two projects (one finished), and a build that streams steps. */
const WAITING = {
  id: 7,
  at: '2026-11-11T17:00:00Z',
  slug: 'club-hr',
  feature: 'F-02',
  path: RUN.path,
  branch: RUN.branch,
  model: 'claude-sonnet-5-5',
  costUsd: 0.42,
  testsPassed: true,
  fixAttempts: 0,
  summary: 'Added the rota page.',
  status: 'built',
  rating: null,
  keptInto: '',
  findings: [] as Finding[],
};

function fakeShell(opts: { decisions?: { id: string; date: string; text: string; feature?: string }[]; blockers?: { id: string; date: string; text: string; feature?: string; open: boolean }[]; map?: Record<string, unknown>; fail?: string; runs?: (typeof WAITING)[]; asks?: { id: number; at: string; slug: string; feature: string; branch: string; tool: string; input: string; reason: string }[] } = {}) {
  let runs = [...(opts.runs ?? [])];
  let asks = [...(opts.asks ?? [])];
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  let send: ((e: BuildEvent) => void) | null = null;
  let finish: ((v: unknown) => void) | null = null;
  let fail: ((e: unknown) => void) | null = null;
  const makeChannel: MakeChannel = <T,>(onMessage: (m: T) => void) => ({ onMessage });
  const invoke: Invoke = routeEngine(async <T,>(cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === 'settings_check') return { gbpPerUsd: 0.79, runCapGbp: 0.8 } as T;
    if (cmd === 'run_list') return runs as T;
    if (cmd === 'workflow_compare') {
      return (runs.length
        ? [{ model: 'claude-sonnet-5-5', name: 'Sonnet 5.5', finished: 0, kept: 0, safetyFailures: 0, text: 'Sonnet 5.5: no build kept or undone yet, 1 waiting.', confidence: { level: 'low', counted: 0, lastBuild: '12 Nov 2026', failed: 0, notCounted: 0, text: 'Low confidence: 0 builds counted, last build 12 Nov 2026, 0 failed (model or tool fault), 0 not counted, no kept builds yet.' } }]
        : []) as T;
    }
    if (cmd === 'work_poll') {
      runs = runs.map((r) => ({ ...r, rating: 5 as unknown as null }));
      return { done: ['From your phone (issue #12): Rated F-02 5/5.'], changed: true } as T;
    }
    if (cmd === 'work_list') {
      return runs.filter((r) => r.status === 'built').map((r, i) => ({ id: i + 1, at: '', kind: 'build', runId: r.id, title: `club-hr ${r.feature}: built, waiting for Keep or Undo`, issue: 12, issueUrl: 'https://github.com/o/r/issues/12' })) as T;
    }
    if (cmd === 'run_decide') {
      const keep = args?.keep === true;
      runs = runs.map((r) => (r.id === args?.id ? { ...r, status: keep ? 'kept' : 'undone', keptInto: keep ? 'main' : '' } : r));
      return { run: runs[0], note: keep ? 'Kept F-02 in your copy on main. Nothing was pushed.' : 'Undone: F-02’s build was removed. Your copy wasn’t touched.', learned: [], phone: 'Closed issue #12 on your phone.' } as T;
    }
    if (cmd === 'run_revert') {
      runs = runs.map((r) => (r.id === args?.id ? { ...r, status: 'reverted' } : r));
      return { run: runs[0], note: 'Undid F-02: a new commit on main reverses it. Nothing was pushed and no history was rewritten.', learned: [] } as T;
    }
    if (cmd === 'deps_approve') {
      runs = runs.map((r) => (r.id === args?.id ? { ...r, findings: r.findings.map((f) => (f.check === 'dependencies' ? { check: 'dependencies', level: 'pass' as const, title: 'New packages: approved by joshua', detail: 'Approved by joshua on 2026-11-12: left-pad ^1.3.0', source: 'rule' as const } : f)) } : r));
      return { run: runs[0], note: 'Approved the new packages for F-02: left-pad ^1.3.0.', keep: { keep: true, blocking: [] } } as T;
    }
    if (cmd === 'ask_list') return asks as T;
    if (cmd === 'ask_decide') {
      const a = asks.find((x) => x.id === args?.id)!;
      asks = asks.filter((x) => x.id !== args?.id);
      return { note: args?.allow ? `Allowed once: ${a.input}.` : `Said No to: ${a.input}.` } as T;
    }
    if (cmd === 'run_rate') {
      runs = runs.map((r) => (r.id === args?.id ? { ...r, rating: args?.rating as null } : r));
      return { run: runs[0], learned: ['New habit: Sonnet builds are usually kept (kept 5 of 5): keep using it for builds.'] } as T;
    }
    if (cmd === 'build_stop') {
      fail?.('Stopped.');
      return true as T;
    }
    if (cmd === 'build_feature') {
      send = (args?.onStep as { onMessage: (e: BuildEvent) => void }).onMessage;
      if (opts.fail) throw opts.fail;
      return new Promise<T>((res, rej) => {
        finish = res as (v: unknown) => void;
        fail = rej;
      });
    }
    const p = (args ?? {}) as Record<string, unknown>;
    if (cmd === 'project_list') {
      return [
        { slug: 'draft', name: 'Draft', status: 'Planning', finished: false, updatedAt: '' },
        { slug: 'club-hr', name: 'Club HR', status: 'Spec ready', finished: true, updatedAt: '' },
      ] as T;
    }
    if (cmd === 'decisions_get') return { version: 1, decisions: opts.decisions ?? [], blockers: opts.blockers ?? [] } as T;
    if (cmd === 'project_map') return { version: 1, updatedAt: null, features: opts.map ?? {} } as T;
    if (cmd === 'interview_get' && p.slug === 'club-hr') {
      return { interview: { features: [{ id: 'F-01', name: 'Login', what: '' }, { id: 'F-02', name: 'Rota', what: '' }] } } as T;
    }
    throw `unexpected ${cmd}`;
  });
  return {
    invoke,
    makeChannel,
    calls,
    step: (e: BuildEvent) => send!(e),
    done: (v: unknown) => finish!(v),
  };
}

describe('Build screen: project map', () => {
  it('shows how many files and tests the feature touched before, with the list, and asks the engine for this project', async () => {
    const shell = fakeShell({ map: { 'F-01': { title: 'Login', files: ['src/Login.tsx', 'src/Login.test.tsx', 'src/Session.ts'], tests: ['src/Login.test.tsx'], lastBuildId: 3, lastKeptAt: '2026-11-12T09:00:00Z' } } });
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    expect(await screen.findByText('This feature touched before: 3 files, 1 test')).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Files this feature touched before' });
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['src/Login.tsx', 'src/Login.test.tsx (test)', 'src/Session.ts']);
    expect(shell.calls.find((c) => c.cmd === 'project_map')?.args).toMatchObject({ project: 'club-hr' });
  });

  it('lists the decisions and blockers that name the feature, and reads an old map without them', async () => {
    const entry = { title: 'Login', files: ['a.ts'], tests: [], lastBuildId: 1, lastKeptAt: 'x' };
    const shell = fakeShell({
      map: { 'F-01': { ...entry, decisions: ['DEC-1'], blockers: ['BLK-1', 'BLK-2'] } },
      decisions: [{ id: 'DEC-1', date: '2026-11-12', text: 'Use SQLite', feature: 'F-01' }],
      blockers: [{ id: 'BLK-1', date: '2026-11-12', text: 'Waiting for the logo', feature: 'F-01', open: false }, { id: 'BLK-2', date: '2026-11-12', text: 'Need the rota', feature: 'F-01', open: true }],
    });
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    await screen.findByText('This feature touched before: 1 file, 0 tests');
    const dec = await screen.findByRole('list', { name: 'Decisions for this feature' });
    expect([...dec.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['DEC-1: Use SQLite']);
    const blk = screen.getByRole('list', { name: 'Blockers for this feature' });
    expect([...blk.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['BLK-1: Waiting for the logo (closed)', 'BLK-2: Need the rota']);
    cleanup();
    const old = fakeShell({ map: { 'F-01': entry } });
    render(<Build invoke={old.invoke} makeChannel={old.makeChannel} />);
    await screen.findByText('This feature touched before: 1 file, 0 tests');
    expect(screen.queryByRole('list', { name: 'Decisions for this feature' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Blockers for this feature' })).toBeNull();
  });

  it('says how well the map named the files a kept build changed, and nothing when not measured', async () => {
    const shell = fakeShell({ runs: [{ ...WAITING, status: 'kept', keptInto: 'main', mapHit: 0.8, mapChanged: 5 } as never] });
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    const builds = await screen.findByRole('region', { name: 'Builds' });
    expect(within(builds).getByText(/The map named 4 of 5 files this build changed \(80%\)/)).toBeTruthy();
    cleanup();
    const none = fakeShell({ runs: [{ ...WAITING, status: 'kept', keptInto: 'main', mapHit: null, mapChanged: null } as never] });
    render(<Build invoke={none.invoke} makeChannel={none.makeChannel} />);
    const b2 = await screen.findByRole('region', { name: 'Builds' });
    expect(within(b2).queryByText(/The map named/)).toBeNull();
  });

  it('says New feature for a feature with no files yet', async () => {
    const shell = fakeShell({ map: { 'F-01': { title: 'Login', files: ['a.ts'], tests: [], lastBuildId: 1, lastKeptAt: 'x' } } });
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    await screen.findByText('This feature touched before: 1 file, 0 tests');
    const feature = (await screen.findByRole('option', { name: 'F-02 Rota' })).parentElement as HTMLSelectElement;
    fireEvent.change(feature, { target: { value: 'F-02' } });
    expect(await screen.findByText('New feature: no files yet.')).toBeTruthy();
  });
});

describe('Build screen: open blockers', () => {
  const blockers = [
    { id: 'BLK-1', date: '2026-11-12', text: 'Waiting for the logo', feature: 'F-01', open: true },
    { id: 'BLK-2', date: '2026-11-12', text: 'Old problem', feature: 'F-01', open: false },
    { id: 'BLK-3', date: '2026-11-12', text: 'Rota data missing', feature: 'F-02', open: true },
  ];
  const builds = (shell: ReturnType<typeof fakeShell>) => shell.calls.filter((c) => c.cmd === 'build_feature').length;

  it('shows the open blocker before Build, and asks inline Yes or No; No builds nothing', async () => {
    const shell = fakeShell({ blockers });
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    const alert = await screen.findByRole('alert', { name: 'Blocked' });
    expect(alert.textContent).toContain('Blocked: Waiting for the logo (BLK-1, F-01)');
    expect(alert.textContent).not.toContain('Old problem');
    expect(alert.textContent).not.toContain('Rota data missing');
    fireEvent.click(screen.getByRole('button', { name: /^Build F-01/ }));
    expect(await screen.findByText(/Build it anyway\?/)).toBeTruthy();
    expect(builds(shell)).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(screen.queryByText(/Build it anyway\?/)).toBeNull();
    expect(builds(shell)).toBe(0);
  });

  it('drops the question when you pick another feature, and it stays gone on coming back', async () => {
    const shell = fakeShell({ blockers });
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    await screen.findByRole('alert', { name: 'Blocked' });
    fireEvent.click(screen.getByRole('button', { name: /^Build F-01/ }));
    expect(await screen.findByText(/Build it anyway\?/)).toBeTruthy();
    const feature = screen.getByLabelText('Feature') as HTMLSelectElement;
    fireEvent.change(feature, { target: { value: 'F-02' } });
    expect(screen.queryByText(/Build it anyway\?/)).toBeNull();
    fireEvent.change(feature, { target: { value: 'F-01' } });
    expect(screen.queryByText(/Build it anyway\?/)).toBeNull();
    expect(builds(shell)).toBe(0);
  });

  it('builds when joshua says Yes', async () => {
    const shell = fakeShell({ blockers });
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    await screen.findByRole('alert', { name: 'Blocked' });
    fireEvent.click(screen.getByRole('button', { name: /^Build F-01/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, build anyway' }));
    await waitFor(() => expect(builds(shell)).toBe(1));
  });

  it('builds at once, with no question, when the feature has no open blocker', async () => {
    const shell = fakeShell({ blockers: [blockers[1]!, blockers[2]!] });
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    await screen.findByText(/^Build F-01/, { selector: 'button' });
    await waitFor(() => expect(shell.calls.some((c) => c.cmd === 'decisions_get')).toBe(true));
    expect(screen.queryByRole('alert', { name: 'Blocked' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Build F-01/ }));
    await waitFor(() => expect(builds(shell)).toBe(1));
    expect(screen.queryByText(/Build it anyway\?/)).toBeNull();
  });

  it('a blocker with no feature blocks every feature', async () => {
    const shell = fakeShell({ blockers: [{ id: 'BLK-9', date: 'x', text: 'No budget', open: true }] });
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    expect((await screen.findByRole('alert', { name: 'Blocked' })).textContent).toContain('Blocked: No budget (BLK-9, whole project)');
  });
});

describe('Build screen', () => {
  it('shows the most a run can cost in £ and $', () => {
    expect(limitText(0.8, 0.79)).toBe('£0.80 ($1.01)');
  });

  it('builds one feature of a finished plan, showing the Using line and each step live', async () => {
    const shell = fakeShell();
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    const project = (await screen.findByLabelText('Project')) as HTMLSelectElement;
    expect([...project.options].map((o) => o.textContent)).toEqual(['Club HR']);
    const feature = (await screen.findByRole('option', { name: 'F-02 Rota' })).parentElement as HTMLSelectElement;
    fireEvent.change(feature, { target: { value: 'F-02' } });
    fireEvent.click(screen.getByRole('button', { name: 'Build F-02 (costs up to £0.80 ($1.01))' }));

    // While it runs: the Using line, the steps as they come, and a Stop button.
    shell.step({ type: 'using', using: 'Using: Sonnet 5.5, file edits, shell', run: RUN, advice: ['No builds with Sonnet 5.5 yet, so this way of building is untested.'] });
    expect(await screen.findByText('Using: Sonnet 5.5, file edits, shell')).toBeTruthy();
    // CI-4: what real builds say about this way of building, beside the Using line.
    expect(screen.getByRole('list', { name: 'What real builds say' }).textContent).toBe('No builds with Sonnet 5.5 yet, so this way of building is untested.');
    shell.step({ type: 'step', text: 'Write src/rota.tsx' });
    shell.step({ type: 'step', text: 'Refused: Bash', refused: 'Gatekeeper (push): pushing code needs joshua’s OK.' });
    const steps = await screen.findByRole('list', { name: 'Steps' });
    await within(steps).findByText(/Refused: Bash/);
    expect([...steps.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Write src/rota.tsx',
      'Refused: Bash Gatekeeper (push): pushing code needs joshua’s OK.',
    ]);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(shell.calls.find((c) => c.cmd === 'build_feature')?.args).toMatchObject({ slug: 'club-hr', feature: 'F-02' });

    // The live view (V2 A): the build's own page at desktop and phone sizes while it builds.
    shell.step({ type: 'live', url: null, note: 'Waiting for the build to install its packages.', reloads: false });
    const live = await screen.findByRole('region', { name: 'Live view' });
    await within(live).findByText('Waiting for the build to install its packages.');
    expect(live.querySelectorAll('iframe')).toHaveLength(0);
    shell.step({ type: 'live', url: 'http://127.0.0.1:5173/', note: 'Live: the build’s own copy, updating as it changes.', reloads: false });
    const desktop = (await screen.findByTitle('Desktop live view of the build')) as HTMLIFrameElement;
    const phone = screen.getByTitle('Phone live view of the build') as HTMLIFrameElement;
    expect(desktop.getAttribute('src')).toBe('http://127.0.0.1:5173/');
    expect(phone.getAttribute('src')).toBe('http://127.0.0.1:5173/');
    expect(desktop.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');
    expect(desktop.style.width).toBe('1280px');
    expect(phone.style.width).toBe('390px');
    // Next.js and Vite update the page themselves, so a new step doesn't reload it.
    shell.step({ type: 'step', text: 'Edit src/rota.tsx' });
    await within(steps).findByText('Edit src/rota.tsx');
    expect(screen.getByTitle('Desktop live view of the build')).toBe(desktop);
    shell.step({ type: 'live', url: null, note: 'Live view closed: the build is done. The final pictures follow.', reloads: false });
    await within(live).findByText('Live view closed: the build is done. The final pictures follow.');
    expect(screen.queryByTitle('Desktop live view of the build')).toBeNull();

    shell.done({
      run: RUN,
      using: 'Using: Sonnet 5.5, file edits, shell',
      steps: [{ text: 'Write src/rota.tsx' }, { text: 'Running tests' }, { text: 'Tests pass' }],
      summary: 'Added the rota page. Ran eslint and the tests pass.',
      claims: [
        { topic: 'Tests', agrees: true, note: 'The app checked this itself: passed.' },
        { topic: 'Lint', agrees: null, note: 'The app doesn’t check this itself, so only the model says so.' },
      ],
      questions: ['Should the rota start on Monday? I used Monday.'],
      modelName: 'Sonnet 5.5',
      costText: '£0.33 ($0.42)',
      tests: { passed: true, output: '3 passed', fixAttempts: 0 },
      synced: 'Saved 1 file. Data repo is up to date on GitHub.',
      runId: 7,
      findings: [
        { check: 'secrets', level: 'pass', title: 'Secret scan: passed', detail: 'No keys found in 2 changed files.', source: 'tool' },
        { check: 'checklist', level: 'warn', title: 'Checklist rules: advice (doesn’t stop Keep)', detail: 'src/rota.tsx:3 (Accessibility): Every image needs alt text.', source: 'rule' },
      ],
      keep: { keep: true, blocking: [] },
      pictures: [
        { name: 'desktop', path: '/runs/F-02-pictures/desktop.png', dataUrl: 'data:image/png;base64,AAAA' },
        { name: 'phone', path: '/runs/F-02-pictures/phone.png', dataUrl: 'data:image/png;base64,BBBB' },
      ],
      screensChanged: true,
      picturesNote: 'Pictures taken with Edge; the screens changed since the last build.',
      phone: 'Sent to your phone: issue #12 on o/r.',
    });
    expect((await screen.findByRole('status')).textContent).toBe('Done and the tests pass. Cost: £0.33 ($0.42). Check it, then press Keep or Undo below.');
    const result = screen.getByRole('region', { name: 'Build result' });
    // V2 B: the model's own words, kept apart from what the app checked.
    expect(within(result).getByRole('heading', { name: 'What the model says it did' })).toBeTruthy();
    expect(within(result).getByText('Added the rota page. Ran eslint and the tests pass.')).toBeTruthy();
    const claims = within(result).getByRole('list', { name: 'The model’s claims, checked by the app' });
    expect([...claims.querySelectorAll('li')].map((li) => [li.className, li.textContent])).toEqual([
      ['ok', '✓ Tests: The app checked this itself: passed.'],
      ['unchecked', '? Lint: The app doesn’t check this itself, so only the model says so.'],
    ]);
    expect(within(result).getByText(/on branch aip\/f-02-20261111-170000\. Your own copy wasn’t touched\./)).toBeTruthy();
    expect(within(result).getByText('All tests pass.')).toBeTruthy();
    expect(within(result).getByText('3 passed')).toBeTruthy();
    expect(within(result).getByText('Data folder: Saved 1 file. Data repo is up to date on GitHub.')).toBeTruthy();
    expect(within(result).getByText(/^Secret scan: passed/)).toBeTruthy();
    expect(within(result).getByText('Pictures taken with Edge; the screens changed since the last build.')).toBeTruthy();
    expect((within(result).getByAltText('Phone picture of the build') as HTMLImageElement).src).toBe('data:image/png;base64,BBBB');
    expect(within(result).getByAltText('Desktop picture of the build')).toBeTruthy();
    expect(within(result).getByText(/^Checklist rules: advice \(doesn’t stop Keep\)/)).toBeTruthy();
    expect(within(result).getByText('src/rota.tsx:3 (Accessibility): Every image needs alt text.')).toBeTruthy();
    expect(within(result).getByText('Phone: Sent to your phone: issue #12 on o/r.')).toBeTruthy();
    // D: the model's questions, which joshua can answer from his phone.
    const qs = within(result).getByRole('region', { name: 'The model’s questions' });
    expect([...qs.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Should the rota start on Monday? I used Monday.']);
  });

  it('shows the findings grouped by level, worst first, with plain titles', async () => {
    const shell = fakeShell();
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Build F-01 (costs up to £0.80 ($1.01))' }));
    shell.done({
      run: RUN,
      using: 'Using: Sonnet 5.5',
      steps: [],
      summary: 'Done.',
      claims: [],
      modelName: 'Sonnet 5.5',
      costText: '£0.33 ($0.42)',
      tests: { passed: true, output: '3 passed', fixAttempts: 0 },
      synced: '',
      runId: 9,
      findings: [
        { check: 'secrets', level: 'pass', title: 'Secret scan: passed', source: 'tool' },
        { check: 'audit', level: 'info', title: 'Package audit: not run', detail: 'Not run: no internet.', source: 'tool' },
        { check: 'checklist', level: 'warn', title: 'Checklist rules: advice (doesn’t stop Keep)', detail: 'a.tsx:1 (Security): Use https:// links.', source: 'rule' },
        { check: 'dependencies', level: 'block', title: 'New packages: need your OK before Keep', detail: 'New: left-pad ^1.3.0', source: 'rule' },
      ],
      keep: { keep: false, blocking: ['dependencies'] },
      pictures: [],
      screensChanged: null,
      picturesNote: '',
      phone: '',
    });
    const result = await screen.findByRole('region', { name: 'Build result' });
    const groups = [...result.querySelectorAll('[role="group"].finding-group')];
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Stops Keep', 'Advice (doesn’t stop Keep)', 'Notes', 'Passed']);
    expect(within(groups[0] as HTMLElement).getByText(/^New packages: need your OK before Keep/)).toBeTruthy();
    expect(within(groups[1] as HTMLElement).getByText('a.tsx:1 (Security): Use https:// links.')).toBeTruthy();
    expect(within(groups[2] as HTMLElement).getByText(/^Package audit: not run/)).toBeTruthy();
    // A pass shows only its title.
    expect(within(groups[3] as HTMLElement).getByText('Secret scan: passed')).toBeTruthy();
    expect(within(groups[3] as HTMLElement).queryByText('No keys found')).toBeNull();
  });

  it('shows the done list with ✓ tested, ✗ failed and – not checked, and says how many were never checked', async () => {
    const shell = fakeShell();
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Build F-01 (costs up to £0.80 ($1.01))' }));
    shell.done({
      run: RUN,
      using: 'Using: Sonnet 5.5',
      steps: [],
      summary: 'Done.',
      claims: [],
      modelName: 'Sonnet 5.5',
      costText: '£0.33 ($0.42)',
      tests: { passed: false, output: 'x', fixAttempts: 0 },
      synced: '',
      runId: 9,
      findings: [
        {
          check: 'done-list',
          level: 'block',
          title: 'Done list: 1 of 3 lines have a failing test',
          detail: 'D1 ✓ tested: A member can sign in\nD2 ✗ failed: A wrong password shows an error\nD3 – not checked: Sessions end after a day',
          source: 'rule',
        },
      ],
      keep: { keep: false, blocking: ['tests'] },
      pictures: [],
      screensChanged: null,
      picturesNote: '',
      phone: '',
    });
    const list = await screen.findByRole('region', { name: 'Done list' });
    expect(within(list).getByText('1 of 3 done-list lines were never checked')).toBeTruthy();
    expect([...list.querySelectorAll('li')].map((li) => [li.className, li.textContent])).toEqual([
      ['ok', '✓ tested · D1: A member can sign in'],
      ['bad', '✗ failed · D2: A wrong password shows an error'],
      ['note', '– not checked · D3: Sessions end after a day'],
    ]);
  });

  it('shows why a line with a test is still not checked', () => {
    const lines = doneList([{ check: 'done-list', level: 'warn', title: 't', detail: 'D1 – not checked: Sign in\n  ↳ test has no assertions\nD2 – not checked: Error', source: 'rule' }]);
    expect(lines).toEqual([
      { id: 'D1', text: 'Sign in', status: 'not-checked', reason: 'test has no assertions' },
      { id: 'D2', text: 'Error', status: 'not-checked' },
    ]);
  });

  it('shows no done list for a build saved before coverage existed', async () => {
    const shell = fakeShell();
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Build F-01 (costs up to £0.80 ($1.01))' }));
    shell.done({
      run: RUN, using: 'u', steps: [], summary: 'Done.', claims: [], modelName: 'S', costText: '£0.33 ($0.42)',
      tests: { passed: true, output: '', fixAttempts: 0 }, synced: '', runId: 9,
      findings: [{ check: 'secrets', level: 'pass', title: 'Secret scan: passed', source: 'tool' }],
      keep: { keep: true, blocking: [] }, pictures: [], screensChanged: null, picturesNote: '', phone: '',
    });
    await screen.findByRole('region', { name: 'Build result' });
    expect(screen.queryByRole('region', { name: 'Done list' })).toBeNull();
    expect(doneList([])).toBeNull();
    expect(doneList([{ check: 'done-list', level: 'warn', title: 't', source: 'rule' }])).toBeNull();
  });

  it('reloads a plain page in the live view as the build changes it', async () => {
    const shell = fakeShell();
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Build F-01 (costs up to £0.80 ($1.01))' }));
    shell.step({ type: 'using', using: 'Using: Sonnet 5.5, file edits, shell', run: RUN });
    shell.step({ type: 'live', url: 'http://127.0.0.1:4000/', note: 'Live: the build’s own copy, updating as it changes.', reloads: true });
    const before = await screen.findByTitle('Phone live view of the build');
    shell.step({ type: 'step', text: 'Write index.html' });
    await screen.findByText('Write index.html');
    const after = screen.getByTitle('Phone live view of the build');
    expect(after).not.toBe(before); // a fresh frame shows the new page
    expect(after.getAttribute('src')).toBe('http://127.0.0.1:4000/');
  });

  it('says plainly when the tests still fail after the fix attempts', async () => {
    const shell = fakeShell();
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Build F-01/ }));
    await screen.findByRole('button', { name: 'Stop' });
    shell.done({
      run: RUN,
      using: 'Using: Sonnet 5.5, file edits, shell, tests',
      steps: [{ text: 'Fix attempt 2 of 2' }, { text: 'Tests still fail' }],
      summary: 'Added the rota page.',
      modelName: 'Sonnet 5.5',
      costText: '£0.79 ($1.00)',
      tests: { passed: false, output: 'FAIL rota.test.ts', fixAttempts: 2 },
      synced: '',
      runId: 8,
      findings: [],
      keep: { keep: false, blocking: ['tests'] },
      pictures: [],
      screensChanged: null,
      picturesNote: 'No pictures: there’s no page to show (no Next.js or Vite app, and no index.html).',
    });
    expect((await screen.findByRole('alert')).textContent).toBe('Built, but the tests still fail after 2 fix attempts. Cost: £0.79 ($1.00). It can’t be kept, so Undo it below.');
    expect(within(screen.getByRole('region', { name: 'Build result' })).getByText('Tests fail.')).toBeTruthy();
  });

  it('keeps a waiting build and rates it', async () => {
    const shell = fakeShell({ runs: [WAITING] });
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    const builds = await screen.findByRole('region', { name: 'Builds' });
    expect(within(builds).getByText(/F-02 · .* · tests and checks pass · waiting for Keep or Undo/)).toBeTruthy();
    // CI-4: each way of building, compared from real builds; advice only.
    const compared = await screen.findByRole('region', { name: 'Ways of building compared' });
    expect(within(compared).getByText('Sonnet 5.5: no build kept or undone yet, 1 waiting.')).toBeTruthy();
    expect(within(compared).getByText(/^Low confidence: 0 builds counted, last build 12 Nov 2026,.*no kept builds yet\.$/).className).toBe('confidence low');
    expect(compared.textContent).toContain('the model for each job stays your choice');
    // It needs joshua, and it's on his phone, where he can reply.
    const needs = await screen.findByRole('region', { name: 'Needs you' });
    expect(within(needs).getByText('club-hr F-02: built, waiting for Keep or Undo')).toBeTruthy();
    fireEvent.click(within(needs).getByRole('button', { name: 'Check phone replies now' }));
    expect((await screen.findByText('From your phone (issue #12): Rated F-02 5/5.')).getAttribute('role')).toBe('status');
    expect(within(builds).getByRole('button', { name: '5' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(builds).getByRole('button', { name: 'Keep F-02' }));
    expect((await screen.findByRole('status')).textContent).toBe('Kept F-02 in your copy on main. Nothing was pushed. Closed issue #12 on your phone.');
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull();
    expect(shell.calls).toContainEqual({ cmd: 'run_decide', args: { id: 7, keep: true } });
    expect(within(builds).getByText(/kept into main/)).toBeTruthy();
    expect(within(builds).queryByRole('button', { name: 'Keep F-02' })).toBeNull();

    fireEvent.click(within(builds).getByRole('button', { name: '4' }));
    expect((await screen.findByText('Rated F-02 4/5.')).getAttribute('role')).toBe('status');
    expect(shell.calls).toContainEqual({ cmd: 'run_rate', args: { id: 7, rating: 4 } });
    expect(within(builds).getByRole('button', { name: '4' }).getAttribute('aria-pressed')).toBe('true');
    // The app says what it learned from the rating.
    const learned = screen.getByRole('region', { name: 'What the app learned' });
    expect(within(learned).getByText('New habit: Sonnet builds are usually kept (kept 5 of 5): keep using it for builds.')).toBeTruthy();
  });

  it('undoes a kept build only after an inline Are you sure, and shows the result note', async () => {
    const shell = fakeShell({ runs: [{ ...WAITING, status: 'kept', keptInto: 'main' }] });
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    const builds = await screen.findByRole('region', { name: 'Builds' });
    // Nothing is offered on a waiting build, and nothing is sent before the confirm.
    fireEvent.click(within(builds).getByRole('button', { name: 'Undo this kept build F-02 build 7' }));
    expect(within(builds).getByText('Are you sure? This adds a new commit that reverses it.')).toBeTruthy();
    expect(shell.calls.some((c) => c.cmd === 'run_revert')).toBe(false);
    // No backs out.
    fireEvent.click(within(builds).getByRole('button', { name: 'No, keep F-02' }));
    expect(within(builds).queryByText(/Are you sure/)).toBeNull();
    expect(shell.calls.some((c) => c.cmd === 'run_revert')).toBe(false);
    // Yes sends it.
    fireEvent.click(within(builds).getByRole('button', { name: 'Undo this kept build F-02 build 7' }));
    fireEvent.click(within(builds).getByRole('button', { name: 'Yes, undo kept F-02' }));
    expect((await screen.findByRole('status')).textContent).toBe('Undid F-02: a new commit on main reverses it. Nothing was pushed and no history was rewritten.');
    expect(shell.calls).toContainEqual({ cmd: 'run_revert', args: { id: 7 } });
    await waitFor(() => expect(within(builds).getByText(/kept, then undone/)).toBeTruthy());
    expect(within(builds).queryByRole('button', { name: /Undo this kept build/ })).toBeNull();
  });

  it('shows the plain reason when undoing a kept build is refused', async () => {
    const shell = fakeShell({ runs: [{ ...WAITING, status: 'kept', keptInto: 'main' }] });
    const refuse: Invoke = ((cmd: string, args?: Record<string, unknown>) =>
      cmd === 'engine' && args?.method === 'run_revert' ? Promise.reject(new Error('Your copy (/code) has changes not committed yet. Nothing was changed.')) : shell.invoke(cmd, args)) as Invoke;
    render(<Build invoke={refuse} makeChannel={shell.makeChannel} />);
    const builds = await screen.findByRole('region', { name: 'Builds' });
    fireEvent.click(within(builds).getByRole('button', { name: 'Undo this kept build F-02 build 7' }));
    fireEvent.click(within(builds).getByRole('button', { name: 'Yes, undo kept F-02' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Your copy (/code) has changes not committed yet. Nothing was changed.');
  });

  it('shows a command a rule asked about in Needs you, with Allow once and No', async () => {
    const ask = (id: number, input: string) => ({ id, at: '', slug: 'club-hr', feature: 'F-01', branch: 'aip/f-01', tool: 'Bash', input, reason: "Gatekeeper (push): pushing code needs joshua's OK" });
    const shell = fakeShell({ asks: [ask(3, 'git push origin main'), ask(4, 'docker compose up')] });
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    const needs = await screen.findByRole('region', { name: 'Needs you' });
    expect(within(needs).getByRole('heading').textContent).toBe('Needs you (2)');
    expect(within(needs).getByText('git push origin main')).toBeTruthy();
    expect(needs.textContent).toContain("pushing code needs joshua's OK");
    fireEvent.click(within(needs).getByRole('button', { name: 'Allow once: git push origin main' }));
    expect((await screen.findByRole('status')).textContent).toBe('Allowed once: git push origin main.');
    expect(shell.calls).toContainEqual({ cmd: 'ask_decide', args: { id: 3, allow: true } });
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Needs you' })).queryByText('git push origin main')).toBeNull());
    fireEvent.click(within(screen.getByRole('region', { name: 'Needs you' })).getByRole('button', { name: 'No: docker compose up' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull());
    expect(shell.calls).toContainEqual({ cmd: 'ask_decide', args: { id: 4, allow: false } });
  });

  it('can’t keep a build whose secret scan failed', async () => {
    const shell = fakeShell({ runs: [{ ...WAITING, findings: [{ check: 'secrets', level: 'block', title: 'Secret scan: failed', source: 'tool' }] }] });
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    const keep = (await screen.findByRole('button', { name: 'Keep F-02' })) as HTMLButtonElement;
    expect(keep.disabled).toBe(true);
    expect(screen.getByText(/a check failed · waiting for Keep or Undo/)).toBeTruthy();
  });

  it('shows Approve new packages only while new packages block Keep, and Keep works after it', async () => {
    const waiting = { ...WAITING, findings: [{ check: 'dependencies', level: 'block' as const, title: 'New packages: need your OK before Keep', detail: 'New: left-pad ^1.3.0 (dependencies in package.json)\nNew packages need your OK before Keep.', source: 'rule' as const }] };
    const shell = fakeShell({ runs: [waiting] });
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    const keep = (await screen.findByRole('button', { name: 'Keep F-02' })) as HTMLButtonElement;
    expect(keep.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Approve new packages for F-02' }));
    expect((await screen.findByRole('status')).textContent).toBe('Approved the new packages for F-02: left-pad ^1.3.0.');
    expect(shell.calls).toContainEqual({ cmd: 'deps_approve', args: { id: 7 } });
    expect(screen.queryByRole('button', { name: 'Approve new packages for F-02' })).toBeNull();
    expect(((await screen.findByRole('button', { name: 'Keep F-02' })) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows no approve button when nothing needs approving, or when something else blocks too', async () => {
    const none = fakeShell({ runs: [WAITING] });
    const a = render(<Build invoke={none.invoke} makeChannel={none.makeChannel} />);
    await screen.findByRole('button', { name: 'Keep F-02' });
    expect(screen.queryByRole('button', { name: /Approve new packages/ })).toBeNull();
    a.unmount();
    const failing = fakeShell({ runs: [{ ...WAITING, testsPassed: false, findings: [{ check: 'dependencies', level: 'block', title: 'New packages: need your OK before Keep', detail: 'New: a 1', source: 'rule' }] }] });
    render(<Build invoke={failing.invoke} makeChannel={failing.makeChannel} />);
    await screen.findByRole('button', { name: 'Keep F-02' });
    expect(screen.queryByRole('button', { name: /Approve new packages/ })).toBeNull();
  });

  it('can’t keep a build whose tests fail, only undo it', async () => {
    const shell = fakeShell({ runs: [{ ...WAITING, testsPassed: false }] });
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    const keep = (await screen.findByRole('button', { name: 'Keep F-02' })) as HTMLButtonElement;
    expect(keep.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Undo F-02' }));
    expect((await screen.findByRole('status')).textContent).toBe('Undone: F-02’s build was removed. Your copy wasn’t touched. Closed issue #12 on your phone.');
    expect(screen.queryByRole('group', { name: /Rate F-02/ })).toBeNull();
  });

  it('stops a running build', async () => {
    const shell = fakeShell();
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Build F-01/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Stopped.');
    expect(screen.getByRole('button', { name: /^Build F-01/ })).toBeTruthy();
  });

  it('shows the engine’s reason when a build can’t start', async () => {
    const shell = fakeShell({ fail: 'Set this project’s code folder first: where its repo is cloned on this computer.' });
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Build F-01/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('Set this project’s code folder first: where its repo is cloned on this computer.');
  });

  it('needs the desktop app', () => {
    render(<Build invoke={null} makeChannel={null} />);
    expect(screen.getByText('Building needs the desktop app.')).toBeTruthy();
  });
  it('lists failed, stopped and interrupted builds with the cause and cost so far, and no Keep button', async () => {
    const ended = { ...WAITING, testsPassed: false, summary: '' };
    const shell = fakeShell({
      runs: [
        { ...ended, id: 12, status: 'failed', cause: 'budget', error: 'Stopped: this run would have gone over its cost limit.', costUsd: 0.5 } as never,
        { ...ended, id: 11, status: 'stopped', cause: null, error: 'Stopped.', costUsd: 0 } as never,
        { ...ended, id: 10, status: 'interrupted', cause: null, error: 'The app was closed while this build was running.', costUsd: null } as never,
      ],
    });
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    const list = await screen.findByRole('region', { name: 'Builds' });
    expect(within(list).getByText(/failed: the run hit its cost limit · cost so far £0\.40 \(\$0\.50\)/)).toBeTruthy();
    expect(within(list).getByText(/stopped: you stopped it · cost so far £0\.00 \(\$0\.00\)/)).toBeTruthy();
    expect(within(list).getByText(/interrupted: the app was closed while it was running · cost so far cost not recorded/)).toBeTruthy();
    expect(within(list).queryByRole('button', { name: /^Keep/ })).toBeNull();
    expect(within(list).queryByRole('group', { name: /^Rate/ })).toBeNull();
    expect(within(list).getAllByRole('button', { name: /^Clear the copy of/ })).toHaveLength(3);
  });
});

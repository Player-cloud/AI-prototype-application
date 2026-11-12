// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Build, limitText } from '../src/screens/Build';
import type { BuildEvent, MakeChannel } from '../src/build';
import type { Invoke } from '../src/engine';

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
  checks: [] as { name: string; passed: boolean; advisory?: boolean; detail?: string }[],
};

function fakeShell(opts: { fail?: string; runs?: (typeof WAITING)[] } = {}) {
  let runs = [...(opts.runs ?? [])];
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  let send: ((e: BuildEvent) => void) | null = null;
  let finish: ((v: unknown) => void) | null = null;
  let fail: ((e: unknown) => void) | null = null;
  const makeChannel: MakeChannel = <T,>(onMessage: (m: T) => void) => ({ onMessage });
  const invoke: Invoke = async <T,>(cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === 'settings_get') return { gbpPerUsd: 0.79, runCapGbp: 0.8 } as T;
    if (cmd === 'run_list') return runs as T;
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
    const p = (args?.params ?? {}) as Record<string, unknown>;
    if (args?.method === 'project_list') {
      return [
        { slug: 'draft', name: 'Draft', status: 'Planning', finished: false, updatedAt: '' },
        { slug: 'club-hr', name: 'Club HR', status: 'Spec ready', finished: true, updatedAt: '' },
      ] as T;
    }
    if (args?.method === 'interview_get' && p.slug === 'club-hr') {
      return { interview: { features: [{ id: 'F-01', name: 'Login', what: '' }, { id: 'F-02', name: 'Rota', what: '' }] } } as T;
    }
    throw `unexpected ${cmd} ${String(args?.method)}`;
  };
  return {
    invoke,
    makeChannel,
    calls,
    step: (e: BuildEvent) => send!(e),
    done: (v: unknown) => finish!(v),
  };
}

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
    shell.step({ type: 'using', using: 'Using: Sonnet 5.5, file edits, shell', run: RUN });
    expect(await screen.findByText('Using: Sonnet 5.5, file edits, shell')).toBeTruthy();
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
      modelName: 'Sonnet 5.5',
      costText: '£0.33 ($0.42)',
      tests: { passed: true, output: '3 passed', fixAttempts: 0 },
      synced: 'Saved 1 file. Data repo is up to date on GitHub.',
      runId: 7,
      checks: [
        { name: 'secrets', passed: true, detail: 'No keys found in 2 changed files.' },
        { name: 'checklist', passed: false, advisory: true, detail: 'src/rota.tsx:3 (Accessibility): Every image needs alt text.' },
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
      checks: [],
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

  it('can’t keep a build whose secret scan failed', async () => {
    const shell = fakeShell({ runs: [{ ...WAITING, checks: [{ name: 'secrets', passed: false }] }] });
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    const keep = (await screen.findByRole('button', { name: 'Keep F-02' })) as HTMLButtonElement;
    expect(keep.disabled).toBe(true);
    expect(screen.getByText(/a check failed · waiting for Keep or Undo/)).toBeTruthy();
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
});

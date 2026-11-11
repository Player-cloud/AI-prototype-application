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
    if (cmd === 'run_decide') {
      const keep = args?.keep === true;
      runs = runs.map((r) => (r.id === args?.id ? { ...r, status: keep ? 'kept' : 'undone', keptInto: keep ? 'main' : '' } : r));
      return { run: runs[0], note: keep ? 'Kept F-02 in your copy on main. Nothing was pushed.' : 'Undone: F-02’s build was removed. Your copy wasn’t touched.' } as T;
    }
    if (cmd === 'run_rate') {
      runs = runs.map((r) => (r.id === args?.id ? { ...r, rating: args?.rating as null } : r));
      return runs[0] as T;
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

    shell.done({
      run: RUN,
      using: 'Using: Sonnet 5.5, file edits, shell',
      steps: [{ text: 'Write src/rota.tsx' }, { text: 'Running tests' }, { text: 'Tests pass' }],
      summary: 'Added the rota page.',
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
    });
    expect((await screen.findByRole('status')).textContent).toBe('Done and the tests pass. Cost: £0.33 ($0.42). Check it, then press Keep or Undo below.');
    const result = screen.getByRole('region', { name: 'Build result' });
    expect(within(result).getByText('Added the rota page.')).toBeTruthy();
    expect(within(result).getByText(/on branch aip\/f-02-20261111-170000\. Your own copy wasn’t touched\./)).toBeTruthy();
    expect(within(result).getByText('All tests pass.')).toBeTruthy();
    expect(within(result).getByText('3 passed')).toBeTruthy();
    expect(within(result).getByText('Data folder: Saved 1 file. Data repo is up to date on GitHub.')).toBeTruthy();
    expect(within(result).getByText(/^Secret scan: passed/)).toBeTruthy();
    expect(within(result).getByText(/^Checklist rules: advice \(doesn’t stop Keep\)/)).toBeTruthy();
    expect(within(result).getByText('src/rota.tsx:3 (Accessibility): Every image needs alt text.')).toBeTruthy();
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
    });
    expect((await screen.findByRole('alert')).textContent).toBe('Built, but the tests still fail after 2 fix attempts. Cost: £0.79 ($1.00). It can’t be kept, so Undo it below.');
    expect(within(screen.getByRole('region', { name: 'Build result' })).getByText('Tests fail.')).toBeTruthy();
  });

  it('keeps a waiting build and rates it', async () => {
    const shell = fakeShell({ runs: [WAITING] });
    render(<Build invoke={shell.invoke} makeChannel={shell.makeChannel} />);
    const builds = await screen.findByRole('region', { name: 'Builds' });
    expect(within(builds).getByText(/F-02 · .* · tests and checks pass · waiting for Keep or Undo/)).toBeTruthy();
    fireEvent.click(within(builds).getByRole('button', { name: 'Keep F-02' }));
    expect((await screen.findByRole('status')).textContent).toBe('Kept F-02 in your copy on main. Nothing was pushed.');
    expect(shell.calls).toContainEqual({ cmd: 'run_decide', args: { id: 7, keep: true } });
    expect(within(builds).getByText(/kept into main/)).toBeTruthy();
    expect(within(builds).queryByRole('button', { name: 'Keep F-02' })).toBeNull();

    fireEvent.click(within(builds).getByRole('button', { name: '4' }));
    expect((await screen.findByText('Rated F-02 4/5.')).getAttribute('role')).toBe('status');
    expect(shell.calls).toContainEqual({ cmd: 'run_rate', args: { id: 7, rating: 4 } });
    expect(within(builds).getByRole('button', { name: '4' }).getAttribute('aria-pressed')).toBe('true');
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
    expect((await screen.findByRole('status')).textContent).toBe('Undone: F-02’s build was removed. Your copy wasn’t touched.');
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

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Maintenance } from '../src/screens/Maintenance';
import { MaintenancePanel } from '../src/screens/MaintenancePanel';
import type { AppSettings } from '../src/settings';
import type { MaintenanceResult } from '../src/data';
import type { Invoke } from '../src/engine';
import { routeEngine } from './shell';

afterEach(cleanup);

const BASE = { provider: 'claude', extraRules: [], codeFolders: { 'club-hr': '/code/club-hr', blog: '/code/blog' } } as unknown as AppSettings;

function fakeShell(start: { patchUpdates: boolean }, opts: { failSave?: boolean; answers?: Record<string, MaintenanceResult> } = {}) {
  let stored = { ...BASE, maintenance: start } as AppSettings;
  const saves: AppSettings[] = [];
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const invoke: Invoke = routeEngine(async <T,>(cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === 'settings_check') return stored as T;
    if (cmd === 'settings_save') {
      if (opts.failSave) throw 'Dev-tool patch updates must be on or off';
      stored = args?.settings as AppSettings;
      saves.push(stored);
      return stored as T;
    }
    if (cmd === 'maintenance_run') {
      const answer = opts.answers?.[String(args?.slug)];
      if (!answer) throw 'Couldn’t look for updates: the engine isn’t answering.';
      return answer as T;
    }
    throw `unexpected ${cmd}`;
  });
  return { invoke, saves, calls };
}

describe('Settings: self-maintenance toggle (Q-5)', () => {
  it('is off by default, explains itself in plain words, and says nothing is merged without Keep', async () => {
    render(<Maintenance invoke={fakeShell({ patchUpdates: false }).invoke} />);
    const box = (await screen.findByRole('checkbox', { name: /Let the app prepare dev-tool patch updates/ })) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.checked).toBe(false);
    expect(screen.getByText(/Off unless you turn it on/)).toBeTruthy();
    expect(screen.getByText(/--ignore-scripts|without running any package’s own scripts/)).toBeTruthy();
    expect(screen.getByText(/waits in Build for you to press Keep/)).toBeTruthy();
    expect(screen.getByText(/never merges or pushes by itself/)).toBeTruthy();
  });

  it('turning it on and off saves only that setting on top of the others', async () => {
    const shell = fakeShell({ patchUpdates: false });
    render(<Maintenance invoke={shell.invoke} />);
    const box = (await screen.findByRole('checkbox')) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.click(box);
    await waitFor(() => expect(shell.saves).toHaveLength(1));
    expect(shell.saves[0]).toEqual({ ...BASE, maintenance: { patchUpdates: true } });
    expect((await screen.findByRole('status')).textContent).toMatch(/^On\./);
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true));
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(shell.saves).toHaveLength(2));
    expect(shell.saves[1]!.maintenance).toEqual({ patchUpdates: false });
    expect((await screen.findByText(/^Off\. The app won’t prepare/))).toBeTruthy();
  });

  it('shows the engine’s plain reason when the save is refused, and stays off', async () => {
    render(<Maintenance invoke={fakeShell({ patchUpdates: false }, { failSave: true }).invoke} />);
    const box = (await screen.findByRole('checkbox')) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.click(box);
    expect((await screen.findByRole('alert')).textContent).toMatch(/must be on or off/);
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });
});

const GREEN: MaintenanceResult = {
  ran: true,
  slug: 'club-hr',
  summary: '1 dev-tool patch update ready for your Keep in Build, 1 rolled back, 1 left to you. Nothing was merged or pushed. GitHub checks not available; local checks only.',
  githubNote: 'GitHub checks not available; local checks only',
  items: [
    { package: 'tool-a', from: '1.2.3', to: '1.2.5', outcome: 'waiting', detail: 'Tests and free checks passed. GitHub checks not available; local checks only. It waits in Build for your Keep.', runId: 4 },
    { package: 'tool-b', from: '3.4.0', to: '3.4.2', outcome: 'rolled back', detail: 'The tests failed with tool-b 3.4.2: Expected 1 to be 2 Rolled back: nothing reached your branch.', runId: 5 },
    { package: 'tool-c', from: '0.5.1', to: '1.0.0', outcome: 'skipped', detail: 'tool-c 0.5.1 → 1.0.0: a major update, so it’s left to you.', runId: null },
  ],
};
const QUIET: MaintenanceResult = { ran: true, slug: 'blog', summary: 'Everything in blog is up to date. Nothing reached your branch. Your copy stayed on main. Cost: £0.00 ($0.00).', githubNote: '', items: [] };

describe('Tools: dev-tool patch update results (Q-5)', () => {
  it('when off, says so and offers no run button, and calls nothing', async () => {
    const shell = fakeShell({ patchUpdates: false });
    render(<MaintenancePanel invoke={shell.invoke} />);
    expect(await screen.findByText(/Off\. The app does nothing by itself/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Prepare dev-tool patch updates now/ })).toBeNull();
    expect(shell.calls.map((c) => c.cmd)).toEqual(['settings_check']);
  });

  it('when on, runs each project and shows waiting, rolled-back and left-to-you results with the GitHub note', async () => {
    const shell = fakeShell({ patchUpdates: true }, { answers: { 'club-hr': GREEN, blog: QUIET } });
    render(<MaintenancePanel invoke={shell.invoke} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare dev-tool patch updates now' }));
    const list = await screen.findByRole('list', { name: 'Updates tried in club-hr' });
    expect(within(list).getByText(/tool-a 1\.2\.3 → 1\.2\.5/).textContent).toMatch(/Ready for your Keep\./);
    expect(within(list).getByText(/tool-b 3\.4\.0 → 3\.4\.2/).textContent).toMatch(/Rolled back\..*nothing reached your branch/);
    expect(within(list).getByText(/tool-c/).textContent).toMatch(/Left to you\./);
    expect(screen.getAllByText(/GitHub checks not available; local checks only/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Everything in blog is up to date/)).toBeTruthy();
    expect(shell.calls.filter((c) => c.cmd === 'maintenance_run').map((c) => c.args)).toEqual([{ slug: 'blog' }, { slug: 'club-hr' }]);
  });

  it('shows the engine’s reason when a run fails', async () => {
    const shell = fakeShell({ patchUpdates: true }, { answers: {} });
    render(<MaintenancePanel invoke={shell.invoke} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare dev-tool patch updates now' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

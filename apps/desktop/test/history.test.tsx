// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { History } from '../src/screens/History';
import { Settings } from '../src/screens/Settings';
import type { Invoke } from '../src/engine';
import { routeEngine } from './shell';

afterEach(cleanup);

interface Item { id: number; at: string; label: string; kind: 'settings' | 'file'; undoneAt: string | null; isUndo: boolean }

/** A stand-in shell with an in-memory history; settings undo changes the budget back. */
function fakeShell(start: Item[], opts: { refuse?: string } = {}) {
  let items = [...start];
  let budget = 30;
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const invoke: Invoke = routeEngine(async <T,>(cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === 'history_list') return items as T;
    if (cmd === 'history_undo') {
      if (opts.refuse) throw opts.refuse;
      const target = items.find((i) => i.id === args?.id)!;
      items = [
        { id: items.length + 1, at: '2026-11-11T13:00:00Z', label: `Undo: ${target.label}`, kind: target.kind, undoneAt: null, isUndo: true },
        ...items.map((i) => (i.id === target.id ? { ...i, undoneAt: '2026-11-11T13:00:00Z' } : i)),
      ];
      if (target.kind === 'settings') budget = 20;
      return { kind: target.kind, summary: `Undone: ${target.label}.` } as T;
    }
    if (cmd === 'settings_check') {
      return { provider: 'claude', monthlyBudgetGbp: budget, gbpPerUsd: 0.79, models: { openai: { strong: 'a', everyday: 'b' }, deepseek: { strong: 'c', everyday: 'd' } }, prices: {}, dataFolder: '', extraRules: [] } as T;
    }
    if (cmd === 'gate_rules') return [] as T;
    if (cmd === 'spend_summary') throw 'no spend yet';
    return { provider: String(args?.provider), saved: false } as T;
  });
  return { invoke, calls };
}

const RATED: Item = { id: 1, at: '2026-11-11T12:00:00Z', label: 'Rated EGM 4/5', kind: 'file', undoneAt: null, isUndo: false };
const BUDGET: Item = { id: 2, at: '2026-11-11T12:30:00Z', label: 'Monthly budget £20 → £30', kind: 'settings', undoneAt: null, isUndo: false };

describe('Settings: change history', () => {
  it('says when there are no changes yet', async () => {
    render(<History invoke={fakeShell([]).invoke} />);
    expect(await screen.findByText(/No changes yet/)).toBeTruthy();
  });

  it('undoes a change in one click and shows it as undone', async () => {
    const shell = fakeShell([RATED]);
    render(<History invoke={shell.invoke} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo Rated EGM 4/5' }));
    expect((await screen.findByRole('status')).textContent).toBe('Undone: Rated EGM 4/5.');
    const list = screen.getByRole('list', { name: 'Changes' });
    await waitFor(() => expect(within(list).getByText(/\(undone\)/)).toBeTruthy());
    expect(within(list).getByRole('button', { name: 'Undo Undo: Rated EGM 4/5' })).toBeTruthy();
    expect(shell.calls.find((c) => c.cmd === 'history_undo')?.args).toEqual({ id: 1 });
  });

  it('shows why a change can’t be undone', async () => {
    render(<History invoke={fakeShell([RATED], { refuse: 'This file can’t be undone safely because it has changed since.' }).invoke} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo Rated EGM 4/5' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/can’t be undone safely/);
  });

  it('reloads the budget form after a settings undo', async () => {
    render(<Settings invoke={fakeShell([BUDGET]).invoke} />);
    expect(((await screen.findByLabelText('Monthly budget (£)')) as HTMLInputElement).value).toBe('30');
    fireEvent.click(await screen.findByRole('button', { name: 'Undo Monthly budget £20 → £30' }));
    await waitFor(() => expect((screen.getByLabelText('Monthly budget (£)') as HTMLInputElement).value).toBe('20'));
  });
});

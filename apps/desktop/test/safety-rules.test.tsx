// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SafetyRules } from '../src/screens/SafetyRules';
import type { Invoke } from '../src/engine';
import { routeEngine } from './shell';

afterEach(cleanup);

/** A stand-in shell that keeps settings in memory and lists rules like the engine does. */
function fakeShell(opts: { failSave?: boolean } = {}) {
  let settings = { provider: 'claude', extraRules: [] as { match: string; reason: string }[] };
  const calls: string[] = [];
  const invoke: Invoke = routeEngine(async <T,>(cmd: string, args?: Record<string, unknown>) => {
    calls.push(cmd);
    if (cmd === 'settings_check') return settings as T;
    if (cmd === 'settings_save') {
      if (opts.failSave) throw 'reason must be at least 3 characters';
      settings = args?.settings as typeof settings;
      return settings as T;
    }
    if (cmd === 'gate_rules') {
      return [
        { id: 'no-force-push', reason: 'Force push can wipe history', kind: 'never', source: 'gatekeeper' },
        { id: 'protect-rules', reason: 'The agent cannot change its own rules', kind: 'never', source: 'gatekeeper' },
        ...settings.extraRules.map((r, i) => ({ id: `yours-${i + 1}`, reason: r.reason, kind: 'ask', source: 'yours', match: r.match })),
      ] as T;
    }
    throw `unexpected ${cmd}`;
  });
  return { invoke, calls };
}

describe('Settings: ask-first rules', () => {
  it('shows the built-in rules and says when you have none of your own', async () => {
    render(<SafetyRules invoke={fakeShell().invoke} />);
    const list = await screen.findByRole('list', { name: 'Built-in rules' });
    expect(within(list).getByText(/Force push can wipe history/)).toBeTruthy();
    expect(within(list).getAllByText('Never allowed')).toHaveLength(2);
    expect(screen.getByText(/None yet/)).toBeTruthy();
  });

  it('adds and removes your own rule', async () => {
    const shell = fakeShell();
    render(<SafetyRules invoke={shell.invoke} />);
    await screen.findByRole('list', { name: 'Built-in rules' });
    const add = screen.getByRole('button', { name: 'Add rule' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Words to watch for'), { target: { value: ' stripe ' } });
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'payments need my OK' } });
    fireEvent.click(add);
    const yours = await screen.findByRole('list', { name: 'Your rules' });
    expect(within(yours).getByText(/“stripe”: payments need my OK/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/now waits for your OK/);
    expect((screen.getByLabelText('Words to watch for') as HTMLInputElement).value).toBe('');

    fireEvent.click(within(yours).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Your rules' })).toBeNull());
    expect(screen.getByText(/None yet/)).toBeTruthy();
  });

  it('shows the plain-words reason when a rule is refused and keeps what you typed', async () => {
    render(<SafetyRules invoke={fakeShell({ failSave: true }).invoke} />);
    await screen.findByRole('list', { name: 'Built-in rules' });
    fireEvent.change(screen.getByLabelText('Words to watch for'), { target: { value: 'stripe' } });
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'ok' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/at least 3 characters/);
    expect((screen.getByLabelText('Words to watch for') as HTMLInputElement).value).toBe('stripe');
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Settings } from '../src/screens/Settings';
import type { Invoke } from '../src/engine';

afterEach(cleanup);

// Obviously fake test value, not a real key.
const FAKE = 'sk-ant-test-0000000000000000';

/** A stand-in for the Rust shell that remembers which providers have a key. */
function fakeShell(initial: string[] = []) {
  const saved = new Set(initial);
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const invoke: Invoke = async <T,>(cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    const provider = String(args?.provider);
    if (cmd === 'key_save') {
      if (!String(args?.key).startsWith('sk-')) throw 'this doesn’t look like a key'; // Tauri rejects with a string
      saved.add(provider);
    }
    if (cmd === 'key_remove') saved.delete(provider);
    if (cmd === 'settings_get') return SETTINGS as T;
    if (cmd === 'test_model') {
      if (!saved.has(provider)) throw 'No anthropic key saved. Add it in Settings.';
      const summary =
        provider === 'anthropic'
          ? 'Connected. Haiku 5.5 replied “ready”. Cost: under £0.01 (under $0.01).'
          : 'Connected. OpenAI accepted the key. This check is free.';
      return { ok: true, summary } as T;
    }
    return { provider, saved: saved.has(provider) } as T;
  };
  return { invoke, calls };
}

const SETTINGS = {
  provider: 'claude',
  monthlyBudgetGbp: 20,
  gbpPerUsd: 0.79,
  models: { openai: { strong: 'gpt-5', everyday: 'gpt-5-mini' }, deepseek: { strong: 'deepseek-reasoner', everyday: 'deepseek-chat' } },
  prices: {},
  dataFolder: '',
};

function row(name: string) {
  return screen.getByRole('form', { name: `${name} key` });
}

describe('Settings: API keys', () => {
  it('shows each provider and whether a key is saved', async () => {
    render(<Settings invoke={fakeShell(['anthropic']).invoke} />);
    expect(await within(row('Claude (Anthropic)')).findByText('Key saved')).toBeTruthy();
    expect(await within(row('OpenAI')).findByText('No key')).toBeTruthy();
    expect(await within(row('DeepSeek')).findByText('No key')).toBeTruthy();
  });

  it('uses a hidden input and clears it after saving', async () => {
    const shell = fakeShell();
    render(<Settings invoke={shell.invoke} />);
    const r = row('Claude (Anthropic)');
    const input = within(r).getByLabelText('Claude (Anthropic)') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: FAKE } });
    fireEvent.click(within(r).getByRole('button', { name: 'Save' }));
    expect(await within(r).findByText('Key saved')).toBeTruthy();
    expect(input.value).toBe('');
    expect(shell.calls).toContainEqual({ cmd: 'key_save', args: { provider: 'anthropic', key: FAKE } });
  });

  it('shows the shell’s error and clears the input when a key is refused', async () => {
    render(<Settings invoke={fakeShell().invoke} />);
    const r = row('OpenAI');
    const input = within(r).getByLabelText('OpenAI') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'not-a-key' } });
    fireEvent.click(within(r).getByRole('button', { name: 'Save' }));
    expect((await within(r).findByRole('alert')).textContent).toContain('doesn’t look like a key');
    expect(input.value).toBe('');
    expect(within(r).getByText('No key')).toBeTruthy();
  });

  it('removes a saved key', async () => {
    render(<Settings invoke={fakeShell(['deepseek']).invoke} />);
    const r = row('DeepSeek');
    fireEvent.click(await within(r).findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(within(r).getByText('No key')).toBeTruthy());
    expect(within(r).queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('disables Save until something is typed', async () => {
    render(<Settings invoke={fakeShell().invoke} />);
    const save = within(row('Claude (Anthropic)')).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('never asks the shell for the key itself', async () => {
    const shell = fakeShell(['anthropic']);
    render(<Settings invoke={shell.invoke} />);
    await within(row('Claude (Anthropic)')).findByText('Key saved');
    expect(shell.calls.every((c) => ['key_status', 'key_save', 'key_remove', 'test_model', 'settings_get', 'spend_summary'].includes(c.cmd))).toBe(true);
  });

  it('tests the Claude connection and shows the reply and cost', async () => {
    const shell = fakeShell(['anthropic']);
    render(<Settings invoke={shell.invoke} />);
    const r = row('Claude (Anthropic)');
    fireEvent.click(await within(r).findByRole('button', { name: 'Test connection' }));
    expect(
      await within(r).findByText('Connected. Haiku 5.5 replied “ready”. Cost: under £0.01 (under $0.01).'),
    ).toBeTruthy();
    expect(shell.calls).toContainEqual({ cmd: 'test_model', args: { provider: 'anthropic' } });
  });

  it('tests OpenAI with the free check', async () => {
    const shell = fakeShell(['openai']);
    render(<Settings invoke={shell.invoke} />);
    const r = row('OpenAI');
    fireEvent.click(await within(r).findByRole('button', { name: 'Test connection' }));
    expect(await within(r).findByText('Connected. OpenAI accepted the key. This check is free.')).toBeTruthy();
    expect(shell.calls).toContainEqual({ cmd: 'test_model', args: { provider: 'openai' } });
  });

  it('only offers Test connection once a key is saved', async () => {
    render(<Settings invoke={fakeShell(['openai']).invoke} />);
    await within(row('OpenAI')).findByText('Key saved');
    expect(within(row('DeepSeek')).queryByRole('button', { name: 'Test connection' })).toBeNull();
  });

  it('explains that keys need the desktop app in a browser preview', () => {
    render(<Settings invoke={null} />);
    expect(screen.getByText(/only be saved in the desktop app/)).toBeTruthy();
    expect(screen.getByText(/Budget and models can be changed in the desktop app only/)).toBeTruthy();
  });
});

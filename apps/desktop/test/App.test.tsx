// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/App';
import { SCREENS } from '../src/screens';

afterEach(cleanup);

describe('App shell', () => {
  it('opens on Projects, the main screen', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Projects');
    expect(screen.getByRole('button', { name: 'Projects' }).getAttribute('aria-current')).toBe('page');
  });

  it('shows one rail button per screen', () => {
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(nav.querySelectorAll('button')).toHaveLength(SCREENS.length);
  });

  it('switches screen when a rail button is clicked', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Settings');
    expect(screen.getByRole('button', { name: 'Settings' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Projects' }).getAttribute('aria-current')).toBeNull();
  });

  it('Simple view shows only Projects, Build and Settings, and is saved', async () => {
    const saves: unknown[] = [];
    let saved = { simpleView: false };
    const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'engine' && args?.method === 'settings_check') return saved;
      if (cmd === 'settings_save') {
        saves.push(args?.settings);
        saved = args?.settings as typeof saved;
        return saved;
      }
      if (cmd === 'engine_status') return { state: 'running', version: '0.0.1' };
      throw new Error(`not in this test: ${cmd}`);
    }) as never;
    render(<App invoke={invoke} />);
    fireEvent.click(screen.getByRole('button', { name: 'Capability Centre' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Simple view' }));
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect([...nav.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Projects', 'Build', 'Settings']);
    // The screen you were on is hidden, so you're taken back to Projects.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Projects');
    await waitFor(() => expect(saves).toEqual([{ simpleView: true }]));
  });

  it('shows every screen while Simple view is off (the default)', () => {
    render(<App />);
    expect((screen.getByRole('checkbox', { name: 'Simple view' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole('button', { name: 'Capability Centre' })).toBeTruthy();
  });

  it('keeps the Build screen alive when you visit another screen, so a running build is not lost', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Build' }));
    const el = screen.getByText('Building needs the desktop app.');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(el.isConnected).toBe(true);
    expect(el.closest('[hidden]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Build' }));
    expect(screen.getByText('Building needs the desktop app.')).toBe(el);
    expect(el.closest('[hidden]')).toBeNull();
  });

  it('does not start the Build screen until it is first opened', () => {
    render(<App />);
    expect(screen.queryByText('Building needs the desktop app.')).toBeNull();
  });
});

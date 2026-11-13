// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

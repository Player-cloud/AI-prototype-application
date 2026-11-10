// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { App } from '../src/App';
import { engineLabel, getEngineStatus, type Invoke } from '../src/engine';

afterEach(cleanup);

const running: Invoke = async <T,>() => ({ state: 'running', version: '0.0.1' }) as T;
const failing: Invoke = async () => {
  throw new Error('boom');
};

describe('engine status', () => {
  it('says browser preview when there is no window shell', async () => {
    expect(await getEngineStatus(null)).toEqual({ state: 'stopped', reason: 'browser preview (no window shell)' });
  });

  it('turns a failed call into a stopped status', async () => {
    expect(await getEngineStatus(failing)).toEqual({ state: 'stopped', reason: 'boom' });
  });

  it('labels each state in plain words', () => {
    expect(engineLabel(null)).toBe('Engine: checking…');
    expect(engineLabel({ state: 'running', version: '1.2.3' })).toBe('Engine: running (v1.2.3)');
    expect(engineLabel({ state: 'stopped', reason: 'x' })).toBe('Engine: not running');
  });

  it('shows the running engine in the rail', async () => {
    render(<App invoke={running} />);
    expect((await screen.findByText('Engine: running (v0.0.1)')).getAttribute('role')).toBe('status');
  });

  it('shows not running, with the reason on hover, when the call fails', async () => {
    render(<App invoke={failing} />);
    const badge = await screen.findByText('Engine: not running');
    expect(badge.getAttribute('title')).toBe('boom');
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Tools } from '../src/screens/Tools';
import { savedPercent, type DataOverview, type ToolRow } from '../src/data';
import type { Invoke } from '../src/engine';

afterEach(cleanup);

const row = (name: string, state: ToolRow['state'], extra: Partial<ToolRow> = {}): ToolRow => ({
  name,
  state,
  status: state.toUpperCase(),
  job: `${name} job`,
  evidence: '',
  rating: '-',
  what: '',
  useWhen: '',
  dontUseWhen: '',
  cost: '',
  ...extra,
});

const OVERVIEW: DataOverview = {
  configured: true,
  folder: '/data',
  tools: [
    row('EGM', 'trial'),
    row('Only CLI (oc)', 'on', { what: 'page to outline', useWhen: 'reading docs', rating: '4', evidence: '41% fewer tokens' }),
    row('Old thing', 'off'),
  ],
  habits: ['Plain words.'],
  ruleCount: 12,
  noteCount: 5,
  firstReadTokens: 700,
  allTokens: 10000,
};

const shell = (answer: DataOverview | string, calls: { cmd: string; args?: Record<string, unknown> }[] = [], syncError = ''): Invoke =>
  (async <T,>(cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === 'tool_rate' || cmd === 'data_sync') {
      if (syncError) throw syncError;
      return { committed: cmd === 'tool_rate', pushed: true, summary: 'Saved 1 file. Data repo is up to date on GitHub.' } as T;
    }
    if (cmd !== 'data_overview') throw `unexpected ${cmd}`;
    if (typeof answer === 'string') throw answer;
    return answer as T;
  }) as Invoke;

describe('Tools page', () => {
  it('lists tools in use first with counts and the token saving', async () => {
    render(<Tools invoke={shell(OVERVIEW)} />);
    expect(await screen.findByText('1 of 3 tools on · 1 habits · 12 rules')).toBeTruthy();
    expect(screen.getByText(/about 700 tokens instead of 10,000 for everything \(93% fewer\)/)).toBeTruthy();
    const names = screen
      .getAllByRole('button')
      .map((b) => b.querySelector('.tool-name')?.textContent)
      .filter(Boolean);
    expect(names).toEqual(['Only CLI (oc)', 'EGM', 'Old thing']);
  });

  it('opens a tool card to show when to use it and the rating', async () => {
    render(<Tools invoke={shell(OVERVIEW)} />);
    fireEvent.click(await screen.findByRole('button', { name: /Only CLI/ }));
    expect(screen.getByText('reading docs')).toBeTruthy();
    expect(screen.getByText('4 / 5')).toBeTruthy();
    expect(screen.getByText('41% fewer tokens')).toBeTruthy();
  });

  it('saves a rating and syncs it', async () => {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    render(<Tools invoke={shell(OVERVIEW, calls)} />);
    fireEvent.click(await screen.findByRole('button', { name: /EGM/ }));
    fireEvent.click(screen.getByRole('button', { name: '3' }));
    expect(await screen.findByText('Saved 1 file. Data repo is up to date on GitHub.')).toBeTruthy();
    expect(calls).toContainEqual({ cmd: 'tool_rate', args: { tool: 'EGM', rating: 3 } });
    expect(screen.getByText('3 / 5')).toBeTruthy();
  });

  it('shows why a sync stopped', async () => {
    render(<Tools invoke={shell(OVERVIEW, [], 'Sync stopped: GitHub has changes that clash.')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sync with GitHub' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Sync stopped: GitHub has changes that clash.');
  });

  it('asks for the data folder when none is set', async () => {
    render(<Tools invoke={shell({ configured: false })} />);
    expect(await screen.findByText(/Set your data folder in Settings/)).toBeTruthy();
  });

  it('shows a wrong folder in plain words', async () => {
    render(<Tools invoke={shell('No ledger.md in D:\\x. Choose the folder where ai-prototype-data is cloned.')} />);
    expect((await screen.findByRole('alert')).textContent).toContain('No ledger.md in');
  });

  it('works out the saving', () => {
    expect(savedPercent(70, 1000)).toBe('93%');
    expect(savedPercent(10, 0)).toBe('0%');
  });
});

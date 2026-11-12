// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Centre } from '../src/screens/Centre';
import type { Centre as CentreData, CentreRow } from '../src/data';
import type { Invoke } from '../src/engine';

afterEach(cleanup);

const row = (name: string, lifecycle: CentreRow['lifecycle'], extra: Partial<CentreRow> = {}): CentreRow => ({
  id: name.toLowerCase(),
  name,
  kind: 'tool',
  version: null,
  lifecycle,
  why: 'Ledger: ON',
  tests: 'Not tested: no free test for it yet.',
  regression: '',
  builds: '',
  computers: '',
  health: '',
  rating: 'Not rated',
  ...extra,
});

const DATA: CentreData = {
  configured: true,
  rows: [
    row('secretlint', 'in use', { tests: 'Passed 4 of 4 cases on 13.1.0 (joshu).', version: '13.1.0' }),
    row('Sonnet 5.5', 'in use', { kind: 'model', builds: 'Sonnet 5.5: 1 of 1 builds kept. A first look, not proof.', rating: '4 / 5' }),
    row('axe-core', 'stale', { regression: 'Got worse: axe-planted passed on 4.11.0, failed on 4.12.0.' }),
    row('old-linter', 'retired', { why: 'Ledger: OFF — replaced' }),
  ],
  counts: { 'in use': 2, stale: 1, 'on trial': 0, 'not tested': 0, 'switched off': 0, retired: 1 },
  comparisons: ['Sonnet 5.5: 1 of 1 builds kept. A first look, not proof.', 'To compare ways of building fairly, each needs at least 3 kept or undone builds.'],
  recommendations: ['axe-core changed since it was tested. Run its free test in Tools.'],
};

const shell = (answer: CentreData | string) =>
  (async <T,>(cmd: string) => {
    if (cmd !== 'capability_centre') throw `unexpected ${cmd}`;
    if (typeof answer === 'string') throw answer;
    return answer as T;
  }) as Invoke;

describe('Capability Centre (UI-01)', () => {
  it('shows each capability from real records, with next steps and comparisons', async () => {
    render(<Centre invoke={shell(DATA)} />);
    const list = await screen.findByRole('list', { name: 'Capabilities' });
    expect(within(list).getAllByRole('listitem').filter((li) => li.parentElement === list)).toHaveLength(4);
    expect(list.textContent).toContain('Passed 4 of 4 cases on 13.1.0');
    expect(list.textContent).toContain('Not tested: no free test for it yet.');
    expect(list.textContent).toContain('Got worse: axe-planted passed on 4.11.0');
    expect(list.textContent).toContain('Sonnet 5.5: 1 of 1 builds kept');
    expect(screen.getByRole('region', { name: 'Next steps' }).textContent).toContain('axe-core changed since it was tested');
    expect(screen.getByRole('region', { name: 'Ways of building compared' }).textContent).toContain('at least 3 kept or undone builds');
    // Only states that have something get a filter, and filtering narrows the list.
    expect(screen.queryByRole('button', { name: /On trial/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retired (1)' }));
    expect(within(screen.getByRole('list', { name: 'Capabilities' })).getByText('old-linter')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Capabilities' }).textContent).not.toContain('secretlint');
  });

  it('says so when there is no data folder, or the engine fails', async () => {
    render(<Centre invoke={shell({ configured: false })} />);
    expect(await screen.findByText(/Set your data folder in Settings first/)).toBeTruthy();
    cleanup();
    render(<Centre invoke={shell('No ledger.md in /data.')} />);
    expect((await screen.findByRole('alert')).textContent).toBe('No ledger.md in /data.');
  });

  it('needs the desktop app', () => {
    render(<Centre invoke={null} />);
    expect(screen.getByText(/needs the desktop app/)).toBeTruthy();
  });
});

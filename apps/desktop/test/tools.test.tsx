// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Tools } from '../src/screens/Tools';
import { savedPercent, type DataOverview, type ToolRow } from '../src/data';
import type { Invoke } from '../src/engine';
import { routeEngine } from './shell';

afterEach(cleanup);

const row = (name: string, state: ToolRow['state'], extra: Partial<ToolRow> = {}): ToolRow => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  name,
  kind: 'unknown',
  version: null,
  testedVersion: null,
  state,
  status: state.toUpperCase(),
  job: `${name} job`,
  evidence: '',
  rating: '-',
  what: '',
  useWhen: '',
  dontUseWhen: '',
  cost: '',
  health: '',
  stale: false,
  failuresInRow: 0,
  switchedOff: false,
  trust: 'unknown',
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
  routeEngine((async <T,>(cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === 'tool_rate' || cmd === 'data_sync' || cmd === 'tool_switch_on') {
      if (syncError) throw syncError;
      return { committed: cmd === 'tool_rate', pushed: true, summary: 'Saved 1 file. Data repo is up to date on GitHub.' } as T;
    }
    if (cmd === 'environment_check') {
      return {
        environment: {
          computer: 'lapto',
          checkedAt: '2026-11-12T10:30:00Z',
          os: 'Windows 10.0.26100',
          versions: { pnpm: '10.34.9' },
          checks: [
            { name: 'pnpm', ok: true, detail: 'pnpm 10.34.9 (pinned: 10.34.9).' },
            { name: 'git name for commits', ok: false, detail: 'Not set. Run git config --global user.name "Your Name" and user.email once.' },
          ],
        },
        differences: ['pnpm: joshu 10.20.0, lapto 10.34.9'],
        synced: 'Saved 1 file. Data repo is up to date on GitHub.',
      } as T;
    }
    if (cmd === 'eval_run') {
      return {
        results: [
          { capability: 'secretlint', suite: 'secretlint-planted', outcome: 'passed', detail: '4 of 4 cases right' },
          { capability: 'axe-core', suite: 'axe-planted', outcome: 'blocked', detail: 'run: Couldn’t run here: no browser' },
        ],
        summary: 'Free tests: 1 passed, 1 couldn’t run here (of 2). Cost: £0.00 ($0.00).',
        synced: 'Saved 2 files.',
      } as T;
    }
    if (cmd === 'update_check') return { updates: [], summary: '1 newer version found (1 of the app’s tracked tools), 1 waiting for your OK. Nothing was installed. Cost: £0.00 ($0.00).', synced: '' } as T;
    if (cmd === 'update_decide') {
      return { update: {}, summary: `OK noted for ${String(args?.package)} ${String(args?.to)}. To adopt it, run: pnpm --filter @aip/checks update @secretlint/node@13.1.0`, synced: 'Saved 1 file.' } as T;
    }
    if (cmd === 'experiment_run') {
      return {
        experiments: [{ id: 'x', capability: String(args?.capability), question: 'Q?', verdict: 'Steady: passed in all 3 runs (4/4 cases right each time).', at: '2026-11-12T11:00:00Z', status: 'proposal' }],
        summary: 'Steady: passed in all 3 runs (4/4 cases right each time). Nothing was changed: it’s a proposal. Cost: £0.00 ($0.00).',
        synced: 'Saved 1 file.',
      } as T;
    }
    if (cmd !== 'data_overview') throw `unexpected ${cmd}`;
    if (typeof answer === 'string') throw answer;
    return answer as T;
  }) as Invoke);

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

  it('shows each tool’s stable ID, kind and version, or unknown (CI-1)', async () => {
    const tools = [
      row('Only CLI (oc)', 'on', { id: 'only-cli', kind: 'tool', version: '1.3.0', testedVersion: '1.2.0', stale: true }),
      row('EGM', 'on', { id: 'egm' }),
    ];
    render(<Tools invoke={shell({ ...OVERVIEW, tools })} />);
    fireEvent.click(await screen.findByRole('button', { name: /Only CLI \(oc\)/ }));
    expect(screen.getByText('only-cli')).toBeTruthy();
    expect(screen.getByText('tool')).toBeTruthy();
    expect(screen.getByText('1.3.0 (its evidence is for 1.2.0, retest due)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /EGM/ }));
    expect(screen.getByText('unknown (not seen in use yet)')).toBeTruthy();
    expect(screen.getByText('egm')).toBeTruthy();
  });

  it('checks this computer and compares it with the others (CI-2)', async () => {
    const calls: { cmd: string }[] = [];
    const data = {
      ...OVERVIEW,
      computer: 'lapto',
      environments: [{ computer: 'joshu', checkedAt: '2026-11-11T09:00:00Z', os: 'Windows 10.0.22631', versions: {}, checks: [{ name: 'pnpm', ok: false, detail: 'x' }] }],
      differences: [],
      clashes: ['Only CLI and Jina are both on for “web reading”. Keep one, or mark the other BACKUP.'],
    };
    render(<Tools invoke={shell(data, calls)} />);
    const region = await screen.findByRole('region', { name: 'Computers' });
    expect(region.textContent).toContain('This computer (lapto)');
    expect(region.textContent).toContain('Not checked yet.');
    expect(region.textContent).toMatch(/joshu · Windows 10\.0\.22631 · checked .* · 1 to fix/);
    expect(screen.getByRole('list', { name: 'Tools that clash' }).textContent).toContain('both on for “web reading”');

    fireEvent.click(screen.getByRole('button', { name: 'Check this computer (free)' }));
    expect(await screen.findByText('1 thing to fix on this computer. Saved 1 file. Data repo is up to date on GitHub.')).toBeTruthy();
    expect(calls.some((c) => c.cmd === 'environment_check')).toBe(true);
    const mine = screen.getByRole('list', { name: 'This computer’s checks' });
    expect([...mine.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      '✓ pnpm: pnpm 10.34.9 (pinned: 10.34.9).',
      '✗ git name for commits: Not set. Run git config --global user.name "Your Name" and user.email once.',
    ]);
    expect(screen.getByRole('list', { name: 'Different versions between computers' }).textContent).toBe('pnpm: joshu 10.20.0, lapto 10.34.9');
  });

  it('runs the free tests and shows what each tool was tested on, or untested (CI-3)', async () => {
    const calls: { cmd: string }[] = [];
    const tools = [
      row('secretlint', 'on', { tested: 'Tests: passed (4/4) on lapto, version 11.2.5, 12 Nov 2026. 1 run so far: a first look, not proof.' }),
      row('EGM', 'on'),
    ];
    render(<Tools invoke={shell({ ...OVERVIEW, tools }, calls)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run free tests' }));
    expect(await screen.findByText('Free tests: 1 passed, 1 couldn’t run here (of 2). Cost: £0.00 ($0.00). axe-planted: blocked (run: Couldn’t run here: no browser) Saved 2 files.')).toBeTruthy();
    expect(calls.filter((c) => c.cmd === 'eval_run')).toHaveLength(1);
    expect(calls.filter((c) => c.cmd === 'data_overview')).toHaveLength(2); // reloaded after the run
    fireEvent.click(screen.getByRole('button', { name: /secretlint/ }));
    expect(screen.getByText(/passed \(4\/4\) on lapto.*a first look, not proof/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /EGM/ }));
    expect(screen.getByText('Untested (no repeatable test has run yet).')).toBeTruthy();
  });

  it('flags a tool that got worse after an update, and runs a free steadiness experiment (CI-5)', async () => {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    const tools = [
      row('secretlint', 'on', { testable: true, regression: 'Got worse after updating from 11.2.5 to 11.3.0 on lapto (secretlint-planted): passed (4/4) before, failed (3/4) now.' }),
      row('EGM', 'on'),
    ];
    const experiments = [{ id: 'e1', capability: 'secretlint', question: 'Does secretlint give the same answer every time on this computer?', verdict: 'Steady: passed in all 3 runs (4/4 cases right each time).', at: '2026-11-12T11:00:00Z', status: 'proposal' }];
    render(<Tools invoke={shell({ ...OVERVIEW, tools, experiments }, calls)} />);
    expect((await screen.findByText(/^Got worse after updating from 11\.2\.5 to 11\.3\.0/)).className).toBe('tool-health warn');
    expect(screen.getByRole('region', { name: 'Experiments' }).textContent).toContain('Steady: passed in all 3 runs (4/4 cases right each time). (a proposal: nothing was changed, 12 Nov)');
    fireEvent.click(screen.getByRole('button', { name: /EGM/ }));
    expect(screen.queryByRole('button', { name: /Is it steady/ })).toBeNull(); // no test, so nothing to experiment with
    fireEvent.click(screen.getByRole('button', { name: /secretlint/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Is it steady? (runs its test 3 times, free)' }));
    expect(await screen.findByText('Steady: passed in all 3 runs (4/4 cases right each time). Nothing was changed: it’s a proposal. Cost: £0.00 ($0.00). Saved 1 file.')).toBeTruthy();
    expect(calls.find((c) => c.cmd === 'experiment_run')?.args).toEqual({ capability: 'secretlint' });
  });

  it('looks for updates and takes your OK or no; it never installs (CI-6)', async () => {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    const updates = [
      { package: '@secretlint/node', from: '11.7.1', to: '13.1.0', level: 'major', status: 'found' as const, text: '@secretlint/node 11.7.1 → 13.1.0 (major: may change how it works).', command: '' },
      { package: 'vite', from: '8.3.7', to: '8.3.8', level: 'patch', status: 'approved' as const, text: 'vite 8.3.7 → 8.3.8 (patch). You said OK.', command: 'pnpm --filter @aip/desktop update vite@8.3.8' },
      { package: 'old', from: '1.0.0', to: '2.0.0', level: 'major', status: 'declined' as const, text: 'old: you said no.', command: '' },
    ];
    render(<Tools invoke={shell({ ...OVERVIEW, updates }, calls)} />);
    const region = await screen.findByRole('region', { name: 'Updates' });
    expect(region.textContent).toContain('pnpm --filter @aip/desktop update vite@8.3.8');
    expect(region.textContent).not.toContain('you said no');
    fireEvent.click(screen.getByRole('button', { name: 'Look for updates' }));
    expect(await screen.findByText(/^1 newer version found .* Nothing was installed\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'OK @secretlint/node 13.1.0' }));
    expect(await screen.findByText(/^OK noted for @secretlint\/node 13\.1\.0\. To adopt it, run:/)).toBeTruthy();
    expect(calls.find((c) => c.cmd === 'update_decide')?.args).toEqual({ package: '@secretlint/node', to: '13.1.0', ok: true });
  });

  it('shows whether an installed update really worked, and the way back (CI-8)', async () => {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    const updates = [
      { package: '@secretlint/node', from: '11.7.1', to: '13.1.0', level: 'major', status: 'installed' as const, text: '@secretlint/node 11.7.1 → 13.1.0. Installed, but it did worse: Missed the private key.', command: '', undoCommand: 'pnpm --filter @aip/checks update @secretlint/node@11.7.1', check: { at: '', outcome: 'worse' as const, detail: 'Missed the private key.' } },
      { package: 'vite', from: '8.3.7', to: '8.3.8', level: 'patch', status: 'rolled back' as const, text: 'vite 8.3.7 → 8.3.8. Rolled back to 8.3.7. Say OK again if you want it later.', command: 'pnpm --filter @aip/desktop update vite@8.3.8', undoCommand: '' },
    ];
    render(<Tools invoke={shell({ ...OVERVIEW, updates }, calls)} />);
    const region = await screen.findByRole('region', { name: 'Updates' });
    const back = within(region).getByLabelText('Go back from @secretlint/node 13.1.0');
    expect(back.textContent).toBe('pnpm --filter @aip/checks update @secretlint/node@11.7.1');
    expect(back.closest('li')!.className).toBe('warn');
    expect(region.textContent).toContain('Rolled back to 8.3.7');
    expect(region.textContent).not.toContain('update vite@8.3.8');
    expect(within(region).queryByRole('button', { name: 'OK @secretlint/node 13.1.0' })).toBeNull();
    fireEvent.click(within(region).getByRole('button', { name: 'OK vite 8.3.8' }));
    await screen.findByText(/^OK noted/);
    expect(calls.find((c) => c.cmd === 'update_decide')?.args).toEqual({ package: 'vite', to: '8.3.8', ok: true });
  });

  it('lists instructions that look out of date or clash, changing nothing (CI-7)', async () => {
    const docIssues = ['tools/secretlint.md: written for version 11.7.1, but 13.1.0 is in use. Check its advice still holds, then update its Version: line.'];
    render(<Tools invoke={shell({ ...OVERVIEW, docIssues })} />);
    const region = await screen.findByRole('region', { name: 'Doc check' });
    expect(region.textContent).toContain('tools/secretlint.md: written for version 11.7.1');
    expect(region.textContent).toContain('Nothing was changed');
  });

  it('shows no doc check when the docs are clean', async () => {
    render(<Tools invoke={shell({ ...OVERVIEW, docIssues: [] })} />);
    await screen.findAllByRole('listitem');
    expect(screen.queryByRole('region', { name: 'Doc check' })).toBeNull();
  });

  it('shows tool health under the tool, warning about failures', async () => {
    const tools = [
      row('Only CLI (oc)', 'on', { health: 'Updated to 1.3.0 since it was tested. It gets a quick retest next time it’s used.', stale: true }),
      row('EGM', 'on', { health: '2 failures in a row.', failuresInRow: 2 }),
    ];
    render(<Tools invoke={shell({ ...OVERVIEW, tools })} />);
    const stale = await screen.findByText(/Updated to 1\.3\.0/);
    expect(stale.className).toBe('tool-health');
    expect(screen.getByText('2 failures in a row.').className).toBe('tool-health warn');
  });

  it('switches a switched-off tool back on', async () => {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    const tools = [row('Sonnet 5.5', 'unknown', { health: 'Switched off: 3 failures in a row (last: overloaded).', failuresInRow: 3, switchedOff: true })];
    render(<Tools invoke={shell({ ...OVERVIEW, tools }, calls)} />);
    expect((await screen.findByText(/^Switched off:/)).className).toBe('tool-health warn');
    fireEvent.click(screen.getByRole('button', { name: 'Switch Sonnet 5.5 back on' }));
    expect(await screen.findByText('Saved 1 file. Data repo is up to date on GitHub.')).toBeTruthy();
    expect(calls).toContainEqual({ cmd: 'tool_switch_on', args: { tool: 'Sonnet 5.5' } });
    expect(screen.queryByRole('button', { name: 'Switch Sonnet 5.5 back on' })).toBeNull();
    expect(screen.getByText('It gets a quick retest next time it’s used.')).toBeTruthy();
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

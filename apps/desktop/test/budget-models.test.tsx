// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BudgetModels } from '../src/screens/BudgetModels';
import { dollarsFor, spendLine, toNumber, type AppSettings } from '../src/settings';
import type { Invoke } from '../src/engine';
import { routeEngine } from './shell';

afterEach(cleanup);

const DEFAULTS: AppSettings = {
  provider: 'claude',
  monthlyBudgetGbp: 20,
  gbpPerUsd: 0.79,
  models: { openai: { strong: 'gpt-5', everyday: 'gpt-5-mini' }, deepseek: { strong: 'deepseek-reasoner', everyday: 'deepseek-chat' } },
  prices: {},
  dataFolder: '',
  extraRules: [],
  codeFolders: {},
  maintenance: { patchUpdates: false },
  simpleView: false,
  ownBuildLoop: false,
  gitName: '',
  gitEmail: '',
  runCapGbp: 0.8,
};

/** Stand-in for the Rust shell + engine: refuses a bad rate the way the engine does, saves anything else. */
function fakeShell(start: AppSettings = DEFAULTS) {
  let stored = start;
  const saves: AppSettings[] = [];
  const created: unknown[] = [];
  const invoke: Invoke = routeEngine(async <T,>(cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'settings_check') return stored as T;
    if (cmd === 'data_create') {
      if (!stored.gitName) throw 'Enter “Your name” and “Your email” in Settings and save them first';
      created.push(args);
      return { folder: String(args?.path), summary: `Made a new data folder at ${String(args?.path)}, saved on this computer only (GitHub sync is off). Press Save to use it.` } as T;
    }
    if (cmd === 'spend_summary') return spend(stored) as T;
    if (cmd === 'settings_save') {
      const s = args?.settings as AppSettings;
      saves.push(s);
      if (!(s.gbpPerUsd >= 0.1 && s.gbpPerUsd <= 5)) throw '£ per $ rate must be a number from 0.1 to 5';
      stored = s;
      return s as T;
    }
    throw `unexpected ${cmd}`;
  });
  return { invoke, saves, created };
}

const spend = (s: AppSettings) => ({
  month: '2026-11',
  spentText: '£1.20 ($1.52)',
  budgetGbp: s.monthlyBudgetGbp,
  percentLeft: s.monthlyBudgetGbp === 40 ? 97 : 94,
  calls: 3,
  unknownCalls: 0,
  rulesWin: true,
});

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save budget and models' }));

describe('Budget and models', () => {
  it('shows the saved values with the budget in £ and $', async () => {
    render(<BudgetModels invoke={fakeShell().invoke} />);
    expect(((await screen.findByLabelText('Monthly budget (£)')) as HTMLInputElement).value).toBe('20');
    expect(screen.getByText('≈ $25.32')).toBeTruthy();
    expect((screen.getByLabelText('Provider for the app’s jobs') as HTMLSelectElement).value).toBe('claude');
    expect(screen.getByText(/Opus plans and reviews, Sonnet builds, Haiku reads/)).toBeTruthy();
  });

  it('saves a new provider, budget, model and price', async () => {
    const shell = fakeShell();
    render(<BudgetModels invoke={shell.invoke} />);
    fireEvent.change(await screen.findByLabelText('Provider for the app’s jobs'), { target: { value: 'deepseek' } });
    fireEvent.change(screen.getByLabelText('Monthly budget (£)'), { target: { value: '25' } });
    expect((screen.getByLabelText('Cost limit per build run (£)') as HTMLInputElement).value).toBe('0.8');
    fireEvent.change(screen.getByLabelText('Cost limit per build run (£)'), { target: { value: '1.6' } });
    fireEvent.change(screen.getByLabelText('Everyday model (everything else)', { selector: '#deepseek-everyday' }), {
      target: { value: 'my-model' },
    });
    fireEvent.change(screen.getByLabelText('my-model input price'), { target: { value: '0.3' } });
    fireEvent.change(screen.getByLabelText('my-model output price'), { target: { value: '1.2' } });
    save();
    expect(await screen.findByText('Saved on this computer.')).toBeTruthy();
    expect(shell.saves[0]).toEqual({
      ...DEFAULTS,
      provider: 'deepseek',
      monthlyBudgetGbp: 25,
      runCapGbp: 1.6,
      models: { ...DEFAULTS.models, deepseek: { strong: 'deepseek-reasoner', everyday: 'my-model' } },
      prices: { 'my-model': { inputPerM: 0.3, outputPerM: 1.2 } },
    });
  });

  it('the app’s own build loop is off by default; turning it on asks for the Claude prices and is saved', async () => {
    const shell = fakeShell();
    render(<BudgetModels invoke={shell.invoke} />);
    const box = (await screen.findByLabelText('Use the app’s own build loop for Claude (experimental)')) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.queryByLabelText('claude-sonnet-5-5 input price')).toBeNull();
    fireEvent.click(box);
    fireEvent.change(screen.getByLabelText('claude-sonnet-5-5 input price'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('claude-sonnet-5-5 output price'), { target: { value: '15' } });
    save();
    await waitFor(() => expect(shell.saves).toHaveLength(1));
    expect(shell.saves[0]!.ownBuildLoop).toBe(true);
    expect(shell.saves[0]!.prices).toEqual({ 'claude-sonnet-5-5': { inputPerM: 3, outputPerM: 15 } });
  });

  it('saves the data folder', async () => {
    const shell = fakeShell();
    render(<BudgetModels invoke={shell.invoke} />);
    fireEvent.change(await screen.findByLabelText('Data folder'), { target: { value: ' D:\\data ' } });
    save();
    await waitFor(() => expect(shell.saves).toHaveLength(1));
    expect(shell.saves[0]!.dataFolder).toBe('D:\\data');
  });

  it('creates a new data folder with no terminal: saves the name and email, makes it, then uses it', async () => {
    const shell = fakeShell();
    render(<BudgetModels invoke={shell.invoke} />);
    const create = (await screen.findByRole('button', { name: 'Create a new data folder here' })) as HTMLButtonElement;
    expect(create.disabled).toBe(true); // no path typed yet
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: ' Sam Evaluator ' } });
    fireEvent.change(screen.getByLabelText('Your email'), { target: { value: 'sam@example.com' } });
    fireEvent.change(screen.getByLabelText('Data folder'), { target: { value: 'C:\\Users\\sam\\AI data' } });
    fireEvent.click(create);
    expect(await screen.findByText(/Made a new data folder at C:\\Users\\sam\\AI data.*It’s now your data folder\./)).toBeTruthy();
    expect(shell.created).toEqual([expect.objectContaining({ path: 'C:\\Users\\sam\\AI data' })]);
    expect(shell.saves[0]).toMatchObject({ gitName: 'Sam Evaluator', gitEmail: 'sam@example.com', dataFolder: '' });
    expect(shell.saves.at(-1)).toMatchObject({ gitName: 'Sam Evaluator', dataFolder: 'C:\\Users\\sam\\AI data' });
    expect(((screen.getByLabelText('Data folder')) as HTMLInputElement).value).toBe('C:\\Users\\sam\\AI data');
  });

  it('says what is missing when the name and email are not entered', async () => {
    const shell = fakeShell();
    render(<BudgetModels invoke={shell.invoke} />);
    fireEvent.change(await screen.findByLabelText('Data folder'), { target: { value: '/home/sam/data' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create a new data folder here' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Enter “Your name” and “Your email”');
    expect(shell.created).toEqual([]);
  });

  it('shows the plain reason when a value is refused, and keeps what was typed', async () => {
    const shell = fakeShell();
    render(<BudgetModels invoke={shell.invoke} />);
    fireEvent.change(await screen.findByLabelText('£ per $1'), { target: { value: '' } });
    save();
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '£ per $ rate must be a number from 0.1 to 5');
    expect((screen.getByLabelText('£ per $1') as HTMLInputElement).value).toBe('');
  });

  it('leaves blank prices out so their cost shows as unknown', async () => {
    const shell = fakeShell({ ...DEFAULTS, prices: { 'gpt-5': { inputPerM: 1, outputPerM: 8 } } });
    render(<BudgetModels invoke={shell.invoke} />);
    fireEvent.change(await screen.findByLabelText('gpt-5 input price'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('gpt-5 output price'), { target: { value: '' } });
    save();
    await waitFor(() => expect(shell.saves).toHaveLength(1));
    expect(shell.saves[0]!.prices).toEqual({});
  });

  it('shows a plain error if the settings cannot be read', async () => {
    const invoke: Invoke = async () => {
      throw 'settings file is damaged; save Settings again to replace it';
    };
    render(<BudgetModels invoke={invoke} />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'settings file is damaged; save Settings again to replace it');
  });
});

describe('spend this month', () => {
  it('shows what has been spent against the budget, and updates after a budget change', async () => {
    render(<BudgetModels invoke={fakeShell().invoke} />);
    expect(await screen.findByText('Spent this month: £1.20 ($1.52) of £20 · 94% left')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Monthly budget (£)'), { target: { value: '40' } });
    save();
    expect(await screen.findByText('Spent this month: £1.20 ($1.52) of £40 · 97% left')).toBeTruthy();
  });

  it('mentions unpriced calls and when preferences win', () => {
    const s = { ...spend(DEFAULTS), unknownCalls: 2, rulesWin: false, percentLeft: 20 };
    expect(spendLine(s)).toBe(
      'Spent this month: £1.20 ($1.52) of £20 · 20% left · 2 calls with no price set · under 30% left, so your preferences now win over the general rules',
    );
  });
});

describe('money helpers', () => {
  it('converts £ to $ and treats blanks as not a number', () => {
    expect(dollarsFor(16, 0.79)).toBe('≈ $20.25');
    expect(dollarsFor(Number.NaN, 0.79)).toBe('');
    expect(dollarsFor(10, 0)).toBe('');
    expect(Number.isNaN(toNumber(' '))).toBe(true);
    expect(toNumber('0.5')).toBe(0.5);
  });
});

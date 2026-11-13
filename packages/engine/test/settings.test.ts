import { describe, expect, it } from 'vitest';
import type { ModelAdapter } from '@aip/models';
import { DEFAULT_SETTINGS, checkSettings } from '../src/settings.ts';
import { handleLine, realDeps, type Deps } from '../src/protocol.ts';

// Obviously fake test value, not a real key.
const FAKE_KEY = 'sk-test-0000000000000000';

describe('checkSettings', () => {
  it('gives the defaults when there is no settings file yet', () => {
    expect(checkSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(checkSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps good values and fills the gaps', () => {
    const s = checkSettings({
      provider: 'deepseek',
      monthlyBudgetGbp: 25,
      gbpPerUsd: 0.75,
      models: { deepseek: { everyday: ' my-model ' } },
      prices: { 'deepseek-chat': { inputPerM: 0.3, outputPerM: 1.2 } },
    });
    expect(s.provider).toBe('deepseek');
    expect(s.monthlyBudgetGbp).toBe(25);
    expect(s.gbpPerUsd).toBe(0.75);
    expect(s.models.deepseek).toEqual({ strong: 'deepseek-reasoner', everyday: 'my-model' });
    expect(s.models.openai).toEqual(DEFAULT_SETTINGS.models.openai);
    expect(s.prices).toEqual({ 'deepseek-chat': { inputPerM: 0.3, outputPerM: 1.2 } });
  });

  it('explains bad values in plain words', () => {
    const err = (raw: unknown) => {
      try {
        checkSettings(raw);
        return 'no error';
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(err('x')).toBe('settings must be an object');
    expect(err({ provider: 'gemini' })).toBe('unknown provider: gemini');
    expect(err({ monthlyBudgetGbp: -1 })).toBe('Monthly budget (£) must be a number from 0 to 10000');
    expect(err({ gbpPerUsd: '0.8' })).toBe('£ per $ rate must be a number from 0.1 to 5');
    expect(err({ models: { openai: { strong: 'has space' } } })).toBe('OpenAI strong model must be a model name like deepseek-chat');
    expect(err({ prices: { m: { inputPerM: 1 } } })).toBe('m output price ($ per million tokens) must be a number from 0 to 1000');
    expect(err({ prices: { m: { inputPerM: Number.NaN, outputPerM: 1 } } })).toContain('must be a number');
  });

  it('never stores a key-shaped value as anything but a model name it checked', () => {
    // A model id may not contain spaces or quotes, so pasting text with a key in by mistake is refused.
    expect(() => checkSettings({ models: { openai: { strong: `key ${FAKE_KEY}` } } })).toThrow();
  });
});

describe('settings in the engine', () => {
  it('settings_check returns the filled-in settings', async () => {
    const reply = JSON.parse(await handleLine(JSON.stringify({ id: 1, method: 'settings_check', params: { settings: { gbpPerUsd: 0.8 } } })));
    expect(reply.result).toEqual({ ...DEFAULT_SETTINGS, gbpPerUsd: 0.8 });
    const bad = JSON.parse(await handleLine(JSON.stringify({ id: 2, method: 'settings_check', params: { settings: { gbpPerUsd: 9 } } })));
    expect(bad.error).toBe('£ per $ rate must be a number from 0.1 to 5');
  });

  it('ask uses the chosen model, the prices and the rate', async () => {
    const seen: { model?: string; prices?: unknown } = {};
    const deps: Deps = {
      async makeAdapter(provider, _key, settings, _maxUsd) {
        seen.prices = settings.prices;
        const run: ModelAdapter['run'] = async (t) => {
          seen.model = t.model;
          return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1, costUsd: 1 } };
        };
        return { provider, run };
      },
      pickModel: realDeps.pickModel,
      async modelName(id) {
        return id;
      },
    };
    const settings = { gbpPerUsd: 0.5, models: { openai: { everyday: 'cheap-one' } }, prices: { 'cheap-one': { inputPerM: 1, outputPerM: 2 } } };
    const line = JSON.stringify({ id: 3, method: 'ask', params: { provider: 'openai', apiKey: FAKE_KEY, job: 'read', prompt: 'hi', settings } });
    const reply = JSON.parse(await handleLine(line, deps));
    expect(seen.model).toBe('cheap-one');
    expect(seen.prices).toEqual(settings.prices);
    expect(reply.result.costText).toBe('£0.50 ($1.00)');
  });

  it('realDeps picks Claude models by the per-job rule whatever the settings say', async () => {
    expect(await realDeps.pickModel('claude', 'plan', DEFAULT_SETTINGS)).toBe('claude-opus-5-5');
    expect(await realDeps.pickModel('deepseek', 'plan', DEFAULT_SETTINGS)).toBe('deepseek-reasoner');
  });
});

describe('data folder setting', () => {
  it('is blank by default and trimmed when set', () => {
    expect(DEFAULT_SETTINGS.dataFolder).toBe('');
    expect(checkSettings({ dataFolder: '  C:\\Users\\me\\ai-prototype-data ' }).dataFolder).toBe('C:\\Users\\me\\ai-prototype-data');
  });

  it('refuses things that are not a folder path', () => {
    expect(() => checkSettings({ dataFolder: 5 })).toThrow('Data folder must be a folder path');
    expect(() => checkSettings({ dataFolder: 'a\nb' })).toThrow('Data folder must be a folder path');
  });

  it('keeps a code folder per project, dropping empty ones', () => {
    expect(DEFAULT_SETTINGS.codeFolders).toEqual({});
    expect(checkSettings({ codeFolders: { 'club-hr': ' D:\\code\\club-hr ', school: '' } }).codeFolders).toEqual({ 'club-hr': 'D:\\code\\club-hr' });
    expect(() => checkSettings({ codeFolders: { '../x': '/a' } })).toThrow('isn’t a project folder name');
    expect(() => checkSettings({ codeFolders: { 'club-hr': 'a\nb' } })).toThrow('Code folder for club-hr must be a folder path');
    expect(() => checkSettings({ codeFolders: [] })).toThrow('code folders must be an object');
  });

  it('Simple view is off unless turned on, and must be on or off', () => {
    expect(checkSettings({}).simpleView).toBe(false);
    expect(checkSettings({ simpleView: true }).simpleView).toBe(true);
    expect(() => checkSettings({ simpleView: 'yes' })).toThrow('Simple view must be on or off');
  });

  it('the app’s own build loop is off unless turned on, and the Claude adapter follows it', async () => {
    expect(checkSettings({}).ownBuildLoop).toBe(false);
    expect(checkSettings({ ownBuildLoop: true }).ownBuildLoop).toBe(true);
    expect(() => checkSettings({ ownBuildLoop: 'yes' })).toThrow('must be on or off');
    const task = { model: 'claude-sonnet-5-5', prompt: 'p', cwd: '.', checkTool: async () => ({ allow: true as const }) };
    // The app's own loop refuses to start without a price for the model; the SDK adapter has no such rule.
    const own = await realDeps.makeAdapter('claude', 'sk-ant-test-0000000000000000', checkSettings({ ownBuildLoop: true }), 1);
    await expect(own.build!(task)).rejects.toThrow('Set the price for claude-sonnet-5-5');
    const sdk = await realDeps.makeAdapter('claude', 'sk-ant-test-0000000000000000', checkSettings({}), 1);
    expect(sdk.build).toBeDefined();
  });

  it('keeps the name and email for commits, and refuses odd ones', () => {
    expect(checkSettings({})).toMatchObject({ gitName: '', gitEmail: '' });
    expect(checkSettings({ gitName: '  Sam Evaluator ', gitEmail: 'sam@example.com' })).toMatchObject({ gitName: 'Sam Evaluator', gitEmail: 'sam@example.com' });
    expect(() => checkSettings({ gitEmail: 'not an email' })).toThrow('doesn’t look like an email address');
    expect(() => checkSettings({ gitName: 'two\nlines' })).toThrow('one line');
    expect(() => checkSettings({ gitName: 'a <b>' })).toThrow('no < or >');
  });
});


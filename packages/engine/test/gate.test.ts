import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, checkSettings } from '../src/settings.ts';
import { gate, guardsRules, listRules } from '../src/gate.ts';
import { handleLine } from '../src/protocol.ts';

const withRules = (extraRules: { match: string; reason: string }[]) => checkSettings({ extraRules });

describe('gate', () => {
  it('lets ordinary steps through', () => {
    expect(gate('Bash', { command: 'pnpm test' }, DEFAULT_SETTINGS)).toEqual({ allow: true });
    expect(gate('Read', { file_path: 'packages/gatekeeper/src/index.ts' }, DEFAULT_SETTINGS)).toEqual({ allow: true });
  });

  it('uses the gatekeeper’s own rules', () => {
    expect(gate('Bash', { command: 'git push origin main' }, DEFAULT_SETTINGS)).toMatchObject({ allow: false, askJoshua: true });
    expect(gate('Read', { file_path: '.env' }, DEFAULT_SETTINGS)).toMatchObject({ allow: false, askJoshua: false });
  });

  it('never lets the agent change the rules or the app’s settings, even with an OK', () => {
    const blocked = [
      ['Edit', { file_path: 'packages/gatekeeper/src/index.ts' }],
      ['Write', { file_path: 'C:\\Users\\me\\AppData\\Roaming\\app.aiprototype.desktop\\settings.json' }],
      ['Bash', { command: "sed -i 's/push/x/' packages/gatekeeper/src/index.ts" }],
      ['Bash', { command: 'echo {} > ~/.config/app.aiprototype.desktop/settings.json' }],
      ['PowerShell', { command: 'Remove-Item packages\\gatekeeper -Recurse' }],
      ['Bash', { command: 'git checkout -- packages/gatekeeper' }],
    ] as const;
    for (const [tool, input] of blocked) {
      const d = gate(tool, input, DEFAULT_SETTINGS);
      expect(d, `${tool} ${JSON.stringify(input)}`).toMatchObject({ allow: false, askJoshua: false });
    }
    expect(guardsRules('Bash', { command: 'cat packages/gatekeeper/src/index.ts' })).toEqual({ allow: true });
  });

  it('adds joshua’s own ask-first rules, matching his words as plain text', () => {
    const s = withRules([{ match: 'stripe', reason: 'payments need my OK' }, { match: 'a.b', reason: 'dots are plain dots' }]);
    expect(gate('Bash', { command: 'pnpm add Stripe' }, s)).toEqual({
      allow: false,
      reason: 'Gatekeeper (yours-1): payments need my OK',
      askJoshua: true,
    });
    expect(gate('Bash', { command: 'echo axb' }, s)).toEqual({ allow: true });
    expect(gate('Bash', { command: 'echo a.b' }, s)).toMatchObject({ allow: false });
  });
});

describe('extra rule settings', () => {
  it('checks the words and the reason', () => {
    expect(() => withRules([{ match: 'x', reason: 'too short a match' }])).toThrow('Words to watch for must be 2 to 100 characters');
    expect(() => withRules([{ match: 'stripe', reason: '' }])).toThrow('The reason must be 3 to 200 characters');
    expect(() => checkSettings({ extraRules: 'stripe' })).toThrow('extra rules must be a list');
    expect(withRules([{ match: '  stripe ', reason: ' payments ' }]).extraRules).toEqual([{ match: 'stripe', reason: 'payments' }]);
  });
});

describe('rules for Settings', () => {
  it('lists the guard, the gatekeeper’s rules and joshua’s, in plain words', () => {
    const rules = listRules(withRules([{ match: 'stripe', reason: 'payments need my OK' }]));
    expect(rules[0]).toMatchObject({ id: 'protect-rules', kind: 'never', source: 'app' });
    expect(rules.find((r) => r.id === 'push')).toMatchObject({ kind: 'ask', source: 'gatekeeper' });
    expect(rules.find((r) => r.id === 'key-files')).toMatchObject({ kind: 'never' });
    expect(rules.at(-1)).toEqual({ id: 'yours-1', reason: 'payments need my OK', kind: 'ask', source: 'yours', match: 'stripe' });
  });

  it('is reachable through the engine', async () => {
    const check = JSON.parse(
      await handleLine(JSON.stringify({ id: 1, method: 'gate_check', params: { settings: {}, tool: 'Bash', input: { command: 'git push' } } })),
    );
    expect(check.result).toMatchObject({ allow: false, askJoshua: true });
    const list = JSON.parse(await handleLine(JSON.stringify({ id: 2, method: 'gate_rules', params: { settings: {} } })));
    expect(list.result.length).toBeGreaterThan(5);
  });
});

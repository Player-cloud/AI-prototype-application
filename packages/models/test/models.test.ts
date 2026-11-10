import { describe, expect, it } from 'vitest';
import { pickClaudeModel } from '../src/index.js';

describe('pickClaudeModel', () => {
  it('uses the agreed model per job', () => {
    expect(pickClaudeModel('plan')).toBe('claude-opus-5-5');
    expect(pickClaudeModel('build')).toBe('claude-sonnet-5-5');
    expect(pickClaudeModel('read')).toBe('claude-haiku-5-5');
    expect(pickClaudeModel('code-review')).toBe('claude-haiku-5-5');
    expect(pickClaudeModel('plan-review')).toBe('claude-sonnet-5-5');
  });
  it('escalates code review for security or multi-file changes', () => {
    expect(pickClaudeModel('code-review', { sensitive: true })).toBe('claude-sonnet-5-5');
    expect(pickClaudeModel('code-review', { multiFile: true })).toBe('claude-sonnet-5-5');
    expect(pickClaudeModel('plan', { sensitive: true })).toBe('claude-opus-5-5');
  });
});

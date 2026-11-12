import { describe, expect, it } from 'vitest';
import { failureCause, friendlyError, type Cause } from '../src/index.js';

describe('failureCause', () => {
  const table: [string, Cause][] = [
    ['Stopped.', 'stopped'],
    ['Stopped: this run would have gone over its cost limit.', 'budget'],
    ['error_max_budget_usd', 'budget'],
    ['The budget is used up', 'budget'],
    ['Could not reach Claude. Check the internet connection.', 'network'],
    ['getaddrinfo ENOTFOUND api.anthropic.com', 'network'],
    ['connect ECONNREFUSED 1.2.3.4:443', 'network'],
    ['read ECONNRESET', 'network'],
    ['ETIMEDOUT', 'network'],
    ['fetch failed', 'network'],
    ['429 Too Many Requests', 'provider'],
    ['503 Service Unavailable', 'provider'],
    ['Claude is overloaded', 'provider'],
    ['rate limit reached', 'provider'],
    ['529', 'provider'],
    ['Claude did not accept the API key. Check it in Settings.', 'setup'],
    ['Your Anthropic account has no credit left.', 'setup'],
    ['No Claude API key set', 'setup'],
    ['403 Forbidden', 'setup'],
    ['Claude ended without an answer.', 'model'],
    ['error_max_turns', 'model'],
    ['Reached max turns', 'model'],
    ['invalid tool use', 'model'],
    ['malformed output', 'model'],
    ['error_during_execution', 'model'],
    ['boom', 'unknown'],
    ['', 'unknown'],
  ];
  it.each(table)('%j is %s', (message, cause) => {
    expect(failureCause(message)).toBe(cause);
  });

  it('understands what friendlyError gives back', () => {
    expect(failureCause(friendlyError('invalid x-api-key'))).toBe('setup');
    expect(failureCause(friendlyError('credit balance too low'))).toBe('setup');
    expect(failureCause(friendlyError('error_max_budget_usd'))).toBe('budget');
    expect(failureCause(friendlyError('ENOTFOUND x'))).toBe('network');
  });
});

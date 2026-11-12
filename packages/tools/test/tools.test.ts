import { describe, expect, it } from 'vitest';
import { parseCard, summaryLine } from '../src/index.js';

const md = `# Only CLI (oc)
What: turns a web page into a short numbered outline.
Use when: the agent must read docs or a web page.
Don't use when: the site blocks it (e.g. Stack Overflow); use WebFetch.
Cost: free; about 450 tokens for a first view.`;

describe('tool cards', () => {
  it('reads the fields', () => {
    const c = parseCard('only-cli', md);
    expect(c.what).toMatch(/numbered outline/);
    expect(c.dontUseWhen).toMatch(/Stack Overflow/);
    expect(c.cost).toMatch(/free/);
    expect(c.title).toBe('Only CLI (oc)');
    expect(parseCard('x', 'What: y').title).toBe('x');
  });
  it('reads kind, version and ledger name when written, and says unknown when not (CI-1)', () => {
    expect(parseCard('only-cli', md)).toMatchObject({ kind: 'unknown', version: '', ledger: '' });
    const c = parseCard('haiku', '# Claude Haiku 5.5\nKind: Models\nVersion: claude-haiku-5-5\nLedger: Haiku 5.5\nWhat: cheap.');
    expect(c).toMatchObject({ name: 'haiku', kind: 'model', version: 'claude-haiku-5-5', ledger: 'Haiku 5.5' });
    expect(parseCard('x', 'Kind: spaceship').kind).toBe('unknown');
  });
  it('makes a one-line summary', () => {
    expect(summaryLine(parseCard('only-cli', md))).toBe('only-cli: turns a web page into a short numbered outline.');
  });
});

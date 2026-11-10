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
  it('makes a one-line summary', () => {
    expect(summaryLine(parseCard('only-cli', md))).toBe('only-cli: turns a web page into a short numbered outline.');
  });
});

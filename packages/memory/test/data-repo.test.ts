import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firstRead, loadDataRepo, parseLedger, related, roughTokens, toolState } from '../src/index.js';

const LEDGER = `# Tool ledger

One line per tool: status | job | evidence | tokens/cost | your rating.

- Only CLI (oc) | ON, DEFAULT web reader | web reading | 41% fewer tokens | ~1-3k tok | rating: 4
- WebFetch | BACKUP web reader | web reading when Only CLI fails | baseline | - | rating: -
- Haiku 5.5 | ON | reading, summaries | 5/5 facts | cheap | rating: -
- EGM | TRIAL NEXT | planning | not run yet | - | rating: -
- Opus single-pass plan review | NOT NEEDED (Sonnet as good) | - | 9/10 | - | rating: -
- Desktop Commander | NOT TESTED (PC only) | PC jobs | - | - | rating: -
`;

let folder = '';

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'aip-data-'));
  await mkdir(join(folder, 'tools'));
  await writeFile(join(folder, 'ledger.md'), LEDGER);
  await writeFile(join(folder, 'habits.md'), '# Habits\n\n- Plain words.\n- Money in £ and $.\n');
  await writeFile(join(folder, 'rules.md'), '# Rules\n\n- One tool per job. See [[only-cli]].\n');
  await writeFile(join(folder, 'tools', 'only-cli.md'), '# Only CLI (oc)\nWhat: turns a page into an outline.\nUse when: reading docs.\nCost: free.\n');
  await writeFile(join(folder, 'tools', 'haiku.md'), '# Claude Haiku 5.5\nWhat: the cheapest model.\n');
  await writeFile(join(folder, 'tools', 'axe-core.md'), '# axe-core\nWhat: page checks.\n');
  await writeFile(join(folder, 'tools', 'notes.txt'), 'not a card');
});

afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('ledger', () => {
  it('reads each tool line and skips other text', () => {
    const l = parseLedger(LEDGER);
    expect(l).toHaveLength(6);
    expect(l[0]).toEqual({
      name: 'Only CLI (oc)',
      status: 'ON, DEFAULT web reader',
      job: 'web reading',
      evidence: '41% fewer tokens',
      cost: '~1-3k tok',
      rating: '4',
    });
  });

  it('turns the status into a simple state', () => {
    expect(toolState('ON, always')).toBe('on');
    expect(toolState('BACKUP web reader')).toBe('on');
    expect(toolState('TRIAL NEXT')).toBe('trial');
    expect(toolState('NOT TESTED (PC only)')).toBe('untested');
    expect(toolState('NOT NEEDED')).toBe('off');
    expect(toolState('maybe')).toBe('unknown');
  });
});

describe('loadDataRepo', () => {
  it('joins ledger lines with their tool cards', async () => {
    const repo = await loadDataRepo(folder);
    const byName = Object.fromEntries(repo.tools.map((t) => [t.name, t]));
    expect(byName['Only CLI (oc)']!.card?.what).toBe('turns a page into an outline.');
    expect(byName['Haiku 5.5']!.card?.title).toBe('Claude Haiku 5.5');
    expect(byName['WebFetch']!.card).toBeNull();
    expect(byName['axe-core']!.status).toBe('not in the ledger yet');
    expect(repo.habits).toEqual(['Plain words.', 'Money in £ and $.']);
    expect(repo.rules).toHaveLength(1);
  });

  it('keeps notes linked, so only related ones are read', async () => {
    const repo = await loadDataRepo(folder);
    expect(related(repo.notes, 'rules', 1).map((n) => n.name)).toEqual(['rules', 'only-cli']);
  });

  it('reads only tools in use first, which is much smaller than everything', async () => {
    const repo = await loadDataRepo(folder);
    const first = firstRead(repo);
    expect(first).toContain('- Only CLI (oc): turns a page into an outline.');
    expect(first).toContain('- WebFetch: web reading when Only CLI fails');
    expect(first).not.toContain('EGM');
    expect(first).toContain('- Plain words.');
    const everything = repo.notes.map((n) => n.body).join('\n');
    expect(roughTokens(first)).toBeLessThan(roughTokens(everything));
  });

  it('explains a folder that is not the data repo', async () => {
    await expect(loadDataRepo(join(folder, 'tools'))).rejects.toThrow('No ledger.md in');
  });
});

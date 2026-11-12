import { describe, expect, it } from 'vitest';
import { applyLearned, HEADING, learnHabits } from '../src/learn.ts';
import { bullets } from '../src/data-repo.ts';
import type { Run } from '../src/runlog.ts';

let next = 1;
const run = (over: Partial<Run> = {}): Run => ({
  id: next++,
  at: '2026-11-11T19:30:00.000Z',
  slug: 'club-hr',
  feature: 'F-01',
  path: '/x',
  branch: 'aip/f-01',
  base: 'abc',
  model: 'claude-sonnet-5-5',
  costUsd: 0.4,
  testsPassed: true,
  fixAttempts: 0,
  summary: '',
  findings: [],
  pictures: [],
  status: 'kept',
  rating: null,
  decidedAt: null,
  mergeCommit: '',
  keptInto: '',
  ...over,
});
const many = (n: number, over: Partial<Run> = {}) => Array.from({ length: n }, () => run(over));
const name = (id: string) => (id === 'claude-sonnet-5-5' ? 'Sonnet' : id);

describe('learning habits from builds', () => {
  it('says nothing about a model before 5 decided builds', () => {
    expect(learnHabits([...many(4), run({ status: 'built' })], name)).toEqual([]);
  });

  it('notices a model whose builds are usually kept and rated well', () => {
    const l = learnHabits([...many(4, { rating: 5 }), run({ status: 'undone', rating: 4 })], name);
    expect(l).toEqual([{ id: 'model-good-claude-sonnet-5-5', text: 'Sonnet builds are usually kept (kept 4 of 5, average rating 4.8/5): keep using it for builds.' }]);
  });

  it('notices a model whose builds are often undone', () => {
    const l = learnHabits([...many(3, { status: 'undone' }), ...many(2)], name);
    expect(l[0]?.id).toBe('model-weak-claude-sonnet-5-5');
    expect(l[0]?.text).toContain('kept 2 of 5');
  });

  it('says nothing in the middle ground', () => {
    expect(learnHabits([...many(2, { status: 'undone' }), ...many(3)], name)).toEqual([]);
  });

  it('notices a checklist rule tripped in 3 of the last 10 builds', () => {
    const tripped = { findings: [{ check: 'checklist', level: 'warn' as const, title: 'Checklist rules: advice', source: 'rule' as const, detail: 'src/a.ts:3 (Code): no console.log\nsrc/b.ts:9 (Code): no console.log' }] };
    const l = learnHabits([...many(2, { ...tripped, status: 'built' }), run({ status: 'built' })], name);
    expect(l).toEqual([]);
    const l3 = learnHabits([...many(3, { ...tripped, status: 'built' })], name);
    expect(l3.map((h) => h.text)).toEqual(['Builds keep tripping the checklist rule “Code: no console.log” (3 of the last 3 builds): build it right first time.']);
  });

  it('notices when most recent builds needed fix attempts', () => {
    const recent = [...many(3, { fixAttempts: 1, status: 'built' }), ...many(2, { status: 'built' })];
    expect(learnHabits(recent, name).map((h) => h.id)).toEqual(['fixes-often']);
    expect(learnHabits(recent.slice(0, 4), name)).toEqual([]);
  });
});

describe('writing learned habits into habits.md', () => {
  const mine = '# Habits\n\n- Plain words.\n- Show money in £ and $.\n';

  it('adds its own section, leaving joshua’s lines alone', () => {
    const r = applyLearned(mine, [{ id: 'fixes-often', text: 'Run the tests first.' }]);
    expect(r.added).toEqual(['Run the tests first.']);
    expect(r.md.startsWith(mine.trimEnd())).toBe(true);
    expect(r.md).toContain(`${HEADING}\n`);
    expect(r.md).toContain('- Run the tests first. <!-- learned:fixes-often -->');
    // The app's marker isn't part of the habit the build model reads.
    expect(bullets(r.md)).toEqual(['Plain words.', 'Show money in £ and $.', 'Run the tests first.']);
  });

  it('changes nothing when nothing new was learned', () => {
    const once = applyLearned(mine, [{ id: 'fixes-often', text: 'Run the tests first.' }]).md;
    const again = applyLearned(once, [{ id: 'fixes-often', text: 'Run the tests first.' }]);
    expect(again).toEqual({ md: once, added: [], changed: [], dropped: [] });
    expect(applyLearned(mine, [])).toEqual({ md: mine, added: [], changed: [], dropped: [] });
  });

  it('updates a habit in place and drops one that’s no longer true', () => {
    const once = applyLearned(mine, [
      { id: 'a', text: 'Kept 4 of 5.' },
      { id: 'b', text: 'Fix often.' },
    ]).md;
    const r = applyLearned(once, [{ id: 'a', text: 'Kept 5 of 6.' }]);
    expect(r.changed).toEqual(['Kept 5 of 6.']);
    expect(r.dropped).toEqual(['Fix often.']);
    expect(r.md).not.toContain('Kept 4 of 5.');
    const gone = applyLearned(r.md, []);
    expect(gone.dropped).toEqual(['Kept 5 of 6.']);
    expect(gone.md).toBe(mine);
  });

  it('copes with Windows line endings', () => {
    const r = applyLearned(mine.replace(/\n/g, '\r\n'), [{ id: 'x', text: 'New.' }]);
    expect(r.added).toEqual(['New.']);
    expect(bullets(r.md)).toContain('Plain words.');
  });
});

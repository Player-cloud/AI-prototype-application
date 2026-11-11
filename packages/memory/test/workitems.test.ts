import { describe, expect, it } from 'vitest';
import { WorkItems } from '../src/workitems.ts';

const AT = new Date('2026-11-11T20:00:00Z');

describe('work items', () => {
  it('keeps what needs joshua until it’s done, oldest first', () => {
    const w = WorkItems.open(':memory:');
    const a = w.add(AT, 'build', 7, 'club-hr F-01: built');
    const b = w.add(AT, 'build', 8, 'club-hr F-02: built');
    expect(w.listOpen().map((i) => i.id)).toEqual([a, b]);
    expect(w.get(a)).toMatchObject({ kind: 'build', runId: 7, issue: 0, issueUrl: '', open: true, closedAt: null, readUpTo: null });

    w.posted(a, 12, 'https://github.com/o/r/issues/12', AT);
    expect(w.forRun(7)).toMatchObject({ issue: 12, issueUrl: 'https://github.com/o/r/issues/12', readUpTo: AT.toISOString() });

    w.done(a, AT);
    expect(w.listOpen().map((i) => i.id)).toEqual([b]);
    expect(w.forRun(7)).toBeNull();
    expect(w.get(a)).toMatchObject({ open: false, closedAt: AT.toISOString() });
    w.readTo(b, '2026-11-11T21:00:00Z');
    expect(w.get(b)?.readUpTo).toBe('2026-11-11T21:00:00Z');
    w.close();
  });
});

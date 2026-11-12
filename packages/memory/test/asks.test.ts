import { describe, expect, it } from 'vitest';
import { APPROVAL_HOURS, Asks, normaliseInput } from '../src/asks.ts';

const AT = new Date('2026-11-12T10:00:00Z');
const later = (hours: number) => new Date(AT.getTime() + hours * 3_600_000);
const ask = (over: Partial<Parameters<Asks['add']>[1]> = {}) => ({
  slug: 'club-hr',
  feature: 'F-01',
  branch: 'aip/club-hr/F-01',
  tool: 'Bash',
  input: 'git push origin main',
  reason: "Gatekeeper (push): pushing code needs joshua's OK",
  ...over,
});

describe('asks', () => {
  it('keeps a request open and makes no second one for the same tool and input', () => {
    const a = Asks.open(':memory:');
    const first = a.add(AT, ask());
    expect(first.fresh).toBe(true);
    expect(a.add(AT, ask({ input: '  git   push origin  main ' }))).toEqual({ id: first.id, fresh: false });
    expect(a.listOpen()).toHaveLength(1);
    expect(a.get(first.id)).toMatchObject({ slug: 'club-hr', feature: 'F-01', branch: 'aip/club-hr/F-01', tool: 'Bash', input: 'git push origin main', open: true, answer: null });
    // Another project, or another tool, is its own request.
    expect(a.add(AT, ask({ slug: 'other' })).fresh).toBe(true);
    expect(a.add(AT, ask({ tool: 'PowerShell' })).fresh).toBe(true);
    expect(a.listOpen()).toHaveLength(3);
    a.close();
  });

  it('Allow once is used exactly once', () => {
    const a = Asks.open(':memory:');
    const { id } = a.add(AT, ask());
    expect(a.consume('club-hr', 'Bash', 'git push origin main', AT, 'b1')).toBe(false);
    expect(a.decide(id, true, AT)).toMatchObject({ open: false, answer: 'allow', closedAt: AT.toISOString() });
    expect(a.listOpen()).toEqual([]);
    expect(a.consume('club-hr', 'Bash', ' git  push origin main', later(1), 'aip/club-hr/F-02')).toBe(true);
    expect(a.consume('club-hr', 'Bash', 'git push origin main', later(2), 'aip/club-hr/F-02')).toBe(false);
    expect(() => a.decide(id, true, AT)).toThrow('already answered');
    a.close();
  });

  it('No closes it and approves nothing; a new request can follow', () => {
    const a = Asks.open(':memory:');
    const { id } = a.add(AT, ask());
    expect(a.decide(id, false, AT).answer).toBe('no');
    expect(a.consume('club-hr', 'Bash', 'git push origin main', AT, 'b')).toBe(false);
    expect(a.add(AT, ask()).fresh).toBe(true);
    a.close();
  });

  it('an approval runs out after 24 hours', () => {
    const a = Asks.open(':memory:');
    a.decide(a.add(AT, ask()).id, true, AT);
    expect(APPROVAL_HOURS).toBe(24);
    expect(a.consume('club-hr', 'Bash', 'git push origin main', later(24), 'b')).toBe(false);
    a.decide(a.add(AT, ask()).id, true, AT);
    expect(a.consume('club-hr', 'Bash', 'git push origin main', later(23.9), 'b')).toBe(true);
    a.close();
  });

  it('an approval is for one project and one exact input', () => {
    const a = Asks.open(':memory:');
    a.decide(a.add(AT, ask()).id, true, AT);
    expect(a.consume('other', 'Bash', 'git push origin main', AT, 'b')).toBe(false);
    expect(a.consume('club-hr', 'PowerShell', 'git push origin main', AT, 'b')).toBe(false);
    expect(a.consume('club-hr', 'Bash', 'git push origin main --force', AT, 'b')).toBe(false);
    expect(a.consume('club-hr', 'Bash', 'git push origin main', AT, 'b')).toBe(true);
    a.close();
  });

  it('normalises spaces', () => {
    expect(normaliseInput('  a \t b\n c ')).toBe('a b c');
  });
});

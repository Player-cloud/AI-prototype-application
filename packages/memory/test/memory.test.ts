import { describe, expect, it } from 'vitest';
import { links, related, summaryIndex, type Note } from '../src/index.js';

const notes: Note[] = [
  { name: 'a', description: 'start', body: 'see [[b]] and [[c]]' },
  { name: 'b', description: 'second', body: 'then [[d]]' },
  { name: 'c', description: 'third', body: '' },
  { name: 'd', description: 'far', body: '' },
];

describe('memory', () => {
  it('finds links', () => expect(links(notes[0]!)).toEqual(['b', 'c']));
  it('builds the summary index', () => expect(summaryIndex(notes.slice(0, 2))).toBe('- a: start\n- b: second'));
  it('follows links only as far as asked', () => {
    expect(related(notes, 'a', 1).map((n) => n.name)).toEqual(['a', 'b', 'c']);
    expect(related(notes, 'a', 2).map((n) => n.name)).toEqual(['a', 'b', 'c', 'd']);
  });
});

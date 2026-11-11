import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listProjectSlugs, readProjectJson, slugify, writeProjectFiles } from '../src/index.js';

let folder = '';
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'aip-projects-'));
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('project folders', () => {
  it('makes safe folder names', () => {
    expect(slugify('Club HR!')).toBe('club-hr');
    expect(slugify('  Café  Booking ')).toBe('cafe-booking');
    expect(slugify('!!!')).toBe('');
    expect(slugify('a'.repeat(50))).toHaveLength(40);
  });

  it('writes files inside the project only, and lists planned projects', async () => {
    expect(await listProjectSlugs(folder)).toEqual([]);
    const written = await writeProjectFiles(folder, 'club-hr', { 'interview.json': '{"a":1}', 'done/F-01.md': '# F-01' });
    expect(written).toEqual(['projects/club-hr/interview.json', 'projects/club-hr/done/F-01.md']);
    expect(await readFile(join(folder, 'projects', 'club-hr', 'done', 'F-01.md'), 'utf8')).toBe('# F-01');
    await expect(writeProjectFiles(folder, 'club-hr', { '../../ledger.md': 'x' })).rejects.toThrow('Refused to write outside the project');
    await expect(writeProjectFiles(folder, '../x', { 'a.md': 'x' })).rejects.toThrow('isn’t a valid project folder name');

    await mkdir(join(folder, 'projects', 'notes'), { recursive: true }); // no interview.json: not listed
    expect(await listProjectSlugs(folder)).toEqual(['club-hr']);
    expect(await readProjectJson(folder, 'club-hr')).toEqual({ a: 1 });
    expect(await readProjectJson(folder, 'other')).toBeNull();
  });

  it('explains a damaged interview file', async () => {
    await mkdir(join(folder, 'projects', 'bad'), { recursive: true });
    await writeFile(join(folder, 'projects', 'bad', 'interview.json'), '{oops');
    await expect(readProjectJson(folder, 'bad')).rejects.toThrow('projects/bad/interview.json can’t be read');
  });
});

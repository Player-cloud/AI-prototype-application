import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleLine } from '../src/protocol.ts';

const NOW = new Date('2026-11-12T12:00:00Z');
const deps = { now: () => NOW } as never;
const call = async (method: string, params: Record<string, unknown>) => JSON.parse((await handleLine(JSON.stringify({ id: 1, method, params }), deps))!);

let data = '';
let settings: Record<string, unknown> = {};
beforeEach(async () => {
  data = await mkdtemp(join(tmpdir(), 'aip-ptools-'));
  settings = { dataFolder: data };
  await writeFile(
    join(data, 'ledger.md'),
    [
      '- secretlint | ON | secret scan | caught planted keys',
      '- axe-core | ON | accessibility check | found planted problems',
      '- Sonnet 5.5 | ON | build | 3 builds kept',
      '- shiny-tool | NOT TESTED | - | -',
      '- old-linter | OFF — replaced | lint | -',
      '',
    ].join('\n'),
  );
  await mkdir(join(data, 'tools'));
  await writeFile(join(data, 'tools', 'secretlint.md'), '# secretlint\nWhat: finds keys\nKind: tool\nVersion: 11.7.1\n');
  await mkdir(join(data, 'tool-health'));
  await writeFile(join(data, 'tool-health', 'secretlint.json'), JSON.stringify({ tool: 'secretlint', id: 'secretlint', version: '13.1.0', testedVersion: '13.1.0' }));
  await writeFile(join(data, 'rules.md'), '# Rules\n- Never skip the review on small features\n- Use old-linter before each push\n');
  await writeFile(join(data, 'habits.md'), '# Habits\n- Skip the review on small features\n');
  await call('interview_start', { settings, name: 'Club HR' });
});
afterEach(async () => {
  await rm(data, { recursive: true, force: true });
});

describe('tools for each project (CI-7)', () => {
  it('suggests only tools that are on and fit the project, and says why for each', async () => {
    const r = (await call('project_tools', { settings, slug: 'club-hr' })).result;
    expect(r.approved).toBeNull();
    const why = Object.fromEntries(r.rows.map((x: { id: string; suggested: boolean; why: string }) => [x.id, [x.suggested, x.why]]));
    expect(why).toEqual({
      secretlint: [true, 'On for “secret scan”.'],
      'axe-core': [false, 'This project doesn’t check Accessibility.'],
      'sonnet-5-5': [true, 'On for “build”.'],
      'shiny-tool': [false, 'Not tested yet, so not suggested.'],
      'old-linter': [false, 'OFF in the ledger.'],
    });
  });

  it('saves joshua’s choice (undoable), refuses unknown tools, and keeps projects apart', async () => {
    const db = join(data, 'history.sqlite');
    const bad = await call('project_tools_approve', { settings, slug: 'club-hr', tools: ['nope'], dbPath: db });
    expect(bad.error).toBe('Not in your tools: nope');
    const r = (await call('project_tools_approve', { settings, slug: 'club-hr', tools: ['sonnet-5-5', 'secretlint'], dbPath: db })).result;
    expect(r.summary).toBe('Approved 2 tools for club-hr.');
    expect(r.approved).toEqual(['secretlint', 'sonnet-5-5']);
    expect(r.rows.filter((x: { approved: boolean }) => x.approved).map((x: { id: string }) => x.id)).toEqual(['secretlint', 'sonnet-5-5']);
    expect(await readFile(join(data, 'projects', 'club-hr', 'tools.md'), 'utf8')).toContain('- sonnet-5-5');

    await call('interview_start', { settings, name: 'School' });
    expect((await call('project_tools', { settings, slug: 'school' })).result.approved).toBeNull();

    const h = (await call('history_list', { dbPath: db })).result;
    expect(h[0].label).toBe('Approved 2 tools for club-hr');
    await call('undo', { dbPath: db, id: h[0].id, settings });
    expect((await call('project_tools', { settings, slug: 'club-hr' })).result.approved).toBeNull();
  });

  it('refuses a project that doesn’t exist', async () => {
    expect((await call('project_tools_approve', { settings, slug: 'nope', tools: [] })).error).toMatch(/nope/);
  });
});

describe('reading the docs (CI-7)', () => {
  it('lists old and clashing instructions on the Tools screen, with where they are', async () => {
    await writeFile(join(data, 'projects', 'club-hr', 'rules.md'), '- Run secretlint 11 on every page\n');
    const o = (await call('data_overview', { settings })).result;
    expect(o.docIssues).toEqual([
      'tools/secretlint.md: written for version 11.7.1, but 13.1.0 is in use. Check its advice still holds, then update its Version: line.',
      'rules.md line 3: relies on old-linter, which is switched off: “Use old-linter before each push”',
      'rules.md line 2: “Never skip the review on small features” clashes with habits.md line 2: “Skip the review on small features”',
      'projects/club-hr/rules.md line 1: names secretlint 11, but 13.1.0 is in use: “Run secretlint 11 on every page”',
    ]);
  });
});

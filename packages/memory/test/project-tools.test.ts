import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bulletLines, cardLines, checkDocs, docIssueText, isNegative, readProjectRules, readProjectTools, sameSubject, writeProjectTools, type DocTool } from '../src/index.js';

let folder = '';
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'aip-ptools-'));
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('project tools and rules (CI-7)', () => {
  it('is null until joshua chooses, then keeps his choice sorted', async () => {
    expect(await readProjectTools(folder, 'club-hr')).toBeNull();
    const path = await writeProjectTools(folder, 'club-hr', ['secretlint', 'axe-core', 'secretlint']);
    expect(path).toBe('projects/club-hr/tools.md');
    expect(await readProjectTools(folder, 'club-hr')).toEqual(['axe-core', 'secretlint']);
    expect(await readFile(join(folder, 'projects', 'club-hr', 'tools.md'), 'utf8')).toContain('Chosen by joshua');
  });

  it('an empty choice means no tools, not all tools', async () => {
    await writeProjectTools(folder, 'club-hr', []);
    expect(await readProjectTools(folder, 'club-hr')).toEqual([]);
  });

  it('an empty file (an undone first choice) means nothing chosen', async () => {
    await mkdir(join(folder, 'projects', 'club-hr'), { recursive: true });
    await writeFile(join(folder, 'projects', 'club-hr', 'tools.md'), '');
    expect(await readProjectTools(folder, 'club-hr')).toBeNull();
  });

  it('refuses bad IDs and bad project names', async () => {
    await expect(writeProjectTools(folder, 'club-hr', ['../x'])).rejects.toThrow('Not a tool ID');
    await expect(writeProjectTools(folder, '../x', ['a'])).rejects.toThrow('valid project folder');
    await expect(readProjectTools(folder, 'A B')).rejects.toThrow('valid project folder');
  });

  it("reads a project's own rules, and only that project's", async () => {
    await mkdir(join(folder, 'projects', 'club-hr'), { recursive: true });
    await writeFile(join(folder, 'projects', 'club-hr', 'rules.md'), '# Rules\n- Use British English\n- Keep pages under 1 MB\n');
    expect(await readProjectRules(folder, 'club-hr')).toEqual(['Use British English', 'Keep pages under 1 MB']);
    expect(await readProjectRules(folder, 'school')).toEqual([]);
  });
});

const tool = (t: Partial<DocTool> & { id: string }): DocTool => ({ names: [t.id], cardFile: null, cardVersion: '', inUse: null, off: false, ...t });

describe('reading the docs for old or clashing instructions (CI-7)', () => {
  it('tells never-lines from the rest, and spots the same subject', () => {
    expect(isNegative('Never commit keys')).toBe(true);
    expect(isNegative("Don't use npm")).toBe(true);
    expect(isNegative('Commit keys to the vault')).toBe(false);
    expect(sameSubject('Never write tests after the code', 'Write tests after the code')).toBe(true);
    expect(sameSubject('Never commit keys', 'Commit often')).toBe(false);
  });

  it('flags a card written for an older version', () => {
    const issues = checkDocs([], [tool({ id: 'secretlint', cardFile: 'tools/secretlint.md', cardVersion: '11.7.1', inUse: '13.1.0' })]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('old');
    expect(docIssueText(issues[0]!)).toBe('tools/secretlint.md: written for version 11.7.1, but 13.1.0 is in use. Check its advice still holds, then update its Version: line.');
  });

  it('stays quiet when the versions match or one is unknown', () => {
    expect(checkDocs([], [tool({ id: 'a-tool', cardFile: 'tools/a-tool.md', cardVersion: '1.0.0', inUse: '1.0.0' }), tool({ id: 'b-tool', cardFile: 'tools/b-tool.md', cardVersion: '1.0.0' })])).toEqual([]);
  });

  it('flags a line naming an old major version, with its file and line', () => {
    const src = [{ file: 'rules.md', lines: bulletLines('# Rules\n\n- Run secretlint 11 with the old config\n- Run secretlint 13 first\n') }];
    const issues = checkDocs(src, [tool({ id: 'secretlint', inUse: '13.1.0' })]);
    expect(issues.map(docIssueText)).toEqual(['rules.md line 3: names secretlint 11, but 13.1.0 is in use: “Run secretlint 11 with the old config”']);
  });

  it('flags relying on a switched-off tool, but not a line that avoids it', () => {
    const src = [{ file: 'habits.md', lines: bulletLines('- Check pages with Playwright\n- Never wait on Playwright for small fixes\n') }];
    const issues = checkDocs(src, [tool({ id: 'playwright', names: ['Playwright', 'playwright'], off: true })]);
    expect(issues.map(docIssueText)).toEqual(['habits.md line 1: relies on Playwright, which is switched off: “Check pages with Playwright”']);
  });

  it('flags a rule and a habit that clash, naming both places', () => {
    const src = [
      { file: 'rules.md', lines: bulletLines('- Never skip the review on small features\n') },
      { file: 'habits.md', lines: bulletLines('<!-- learned -->\n- Skip the review on small features\n- Use Sonnet for builds\n') },
    ];
    const issues = checkDocs(src, []);
    expect(issues.map(docIssueText)).toEqual(['rules.md line 1: “Never skip the review on small features” clashes with habits.md line 2: “Skip the review on small features”']);
  });

  it('flags a card whose Use when and Don’t use when say the same', () => {
    const md = '# Thing\nWhat: does things\nUse when: big refactors across files\nDon’t use when: big refactors across files\n';
    const issues = checkDocs([{ file: 'tools/thing.md', lines: cardLines(md) }], []);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('clash');
    expect(issues[0]!.line).toBe(4);
  });

  it('a card does not trip on its own name', () => {
    const md = '# secretlint\nWhat: secretlint 11 finds keys\n';
    expect(checkDocs([{ file: 'tools/secretlint.md', lines: cardLines(md) }], [tool({ id: 'secretlint', cardFile: 'tools/secretlint.md', inUse: '13.1.0' })])).toEqual([]);
  });

  it('finds nothing in clean docs', () => {
    const src = [
      { file: 'rules.md', lines: bulletLines('- Never commit keys\n- Ask before spending money\n') },
      { file: 'habits.md', lines: bulletLines('- Commit often\n- Keep features small\n') },
    ];
    expect(checkDocs(src, [tool({ id: 'secretlint', inUse: '13.1.0' })])).toEqual([]);
  });
});

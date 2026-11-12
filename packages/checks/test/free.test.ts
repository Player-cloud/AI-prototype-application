import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditCheck, canKeep, changedSince, checklistCheck, dependenciesCheck, runFreeChecks, secretScan, type Exec } from '../src/index.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
/** A token-shaped fake made at run time, so this file itself has nothing key-shaped in it. */
const fakeToken = () => ['gh', 'p_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5'].join('');

describe('free checks', () => {
  let dir = '';
  let base = '';
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'aip-free-')));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'user.email', 'test@example.invalid');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'config', 'core.autocrlf', 'false');
    await writeFile(join(dir, 'README.md'), '# App\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'first');
    base = git(dir, 'rev-parse', 'HEAD').trim();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds what the build changed and the lines it added, committed or not', async () => {
    await writeFile(join(dir, 'README.md'), '# App\nNew line\n');
    git(dir, 'commit', '-q', '-am', 'build');
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src', 'page.tsx'), 'export const A = 1;\n');
    const c = await changedSince(dir, base);
    expect(c.files.sort()).toEqual(['README.md', 'src/page.tsx']);
    expect(c.added).toContainEqual({ file: 'README.md', line: 2, text: 'New line' });
    expect(c.added).toContainEqual({ file: 'src/page.tsx', line: 1, text: 'export const A = 1;' });
  });

  it('fails the secret scan on a key in a changed file or a key file, never showing the key', async () => {
    await writeFile(join(dir, 'config.ts'), `export const token = "${fakeToken()}";\n`);
    await writeFile(join(dir, '.env'), 'X=1\n');
    const r = await secretScan(dir, ['config.ts', '.env']);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('.env: key files must never be added to the code.');
    expect(r.detail).toContain('GITHUB_TOKEN');
    expect(r.detail).not.toContain(fakeToken());
    expect((await secretScan(dir, ['README.md'])).detail).toBe('No keys found in 1 changed file.');
  });

  it('fails the audit on high or critical problems, and only advises when it can’t run', async () => {
    await writeFile(join(dir, 'package.json'), '{"name":"x"}');
    await writeFile(join(dir, 'pnpm-lock.yaml'), '');
    const seen: string[][] = [];
    const answer = (code: number, output: string): Exec => async (cmd, args) => (seen.push([cmd, ...args]), { code, output });
    expect(await auditCheck(dir, answer(0, 'No known vulnerabilities found'))).toMatchObject({ name: 'audit', passed: true });
    expect(seen[0]).toEqual(['pnpm', 'audit', '--audit-level', 'high']);
    expect(await auditCheck(dir, answer(1, '1 high severity vulnerability'))).toMatchObject({ passed: false });
    expect((await auditCheck(dir, answer(1, '1 high severity vulnerability'))).advisory).toBeUndefined();
    expect(await auditCheck(dir, answer(1, 'request to https://registry.npmjs.org failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org'))).toMatchObject({
      passed: false,
      advisory: true,
    });
  });

  it('checks the ticked checklist areas on added lines only, as advice', () => {
    const added = [
      { file: 'src/a.tsx', line: 3, text: '<img src="x.png">' },
      { file: 'src/a.tsx', line: 4, text: 'el.innerHTML = userText;' },
      { file: 'src/a.css', line: 1, text: '.box { width: 900px; }' },
      { file: 'docs/notes.md', line: 1, text: 'eval( is bad' },
    ];
    const r = checklistCheck(['Accessibility', 'Security'], added);
    expect(r).toMatchObject({ name: 'checklist', passed: false, advisory: true });
    expect(r.detail?.split('\n')).toEqual([
      'src/a.tsx:3 (Accessibility): Every image needs alt text.',
      'src/a.tsx:4 (Security): Putting raw HTML on the page can let attackers in; use text, or clean the HTML first.',
    ]);
    expect(checklistCheck(['Phone and desktop layout'], added).detail).toBe('src/a.css:1 (Phone and desktop layout): A fixed width of 500px or more won’t fit a phone; use max-width or %.');
    expect(checklistCheck([], added)).toMatchObject({ passed: true, detail: 'No checklist rules for the areas this project ticked.' });
    expect(checklistCheck(['Security'], [{ file: 'a.ts', line: 1, text: 'const ok = 1;' }]).detail).toBe('Checked 1 area: nothing found.');
  });

  it('runs all of them, and only blocking failures stop Keep', async () => {
    await writeFile(join(dir, 'page.tsx'), '<img src="a.png">\n');
    const results = await runFreeChecks(dir, base, ['Accessibility'], async (cmd, args, cwd) =>
      cmd === 'git' ? { code: 0, output: execFileSync('git', args, { cwd, encoding: 'utf8' }) } : { code: 0, output: 'ok' },
    );
    expect(results.map((r) => [r.name, r.passed])).toEqual([
      ['secrets', true],
      ['audit', true],
      ['dependencies', true],
      ['checklist', false],
    ]);
    expect(canKeep([{ name: 'tests', passed: true, free: true }, ...results])).toEqual({ keep: true, blocking: [] });
    expect(canKeep([{ name: 'tests', passed: true, free: true }, { name: 'secrets', passed: false, free: true }])).toEqual({ keep: false, blocking: ['secrets'] });
  });

  describe('new packages', () => {
    const pkg = (deps: Record<string, string>, dev: Record<string, string> = {}) => JSON.stringify({ name: 'app', dependencies: deps, devDependencies: dev }, null, 2);
    const check = async () => dependenciesCheck(dir, base, (await changedSince(dir, base)).files);
    beforeEach(async () => {
      await writeFile(join(dir, 'package.json'), pkg({ react: '^19.0.0' }, { vitest: '^4.0.0' }));
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'with packages');
      base = git(dir, 'rev-parse', 'HEAD').trim();
    });

    it('passes when nothing changed', async () => {
      expect(await check()).toEqual({ name: 'dependencies', passed: true, free: true, detail: 'No new packages.' });
    });

    it('fails and lists a new package with its version, and it is not advice', async () => {
      await writeFile(join(dir, 'package.json'), pkg({ react: '^19.0.0', 'left-pad': '^1.3.0' }, { vitest: '^4.0.0', zod: '~3.0.0' }));
      const r = await check();
      expect(r.passed).toBe(false);
      expect(r.advisory).toBeUndefined();
      expect(r.detail).toBe(['New: left-pad ^1.3.0 (dependencies in package.json)', 'New: zod ~3.0.0 (devDependencies in package.json)', 'New packages need your OK before Keep.'].join('\n'));
      expect(canKeep([{ name: 'tests', passed: true, free: true }, r]).blocking).toEqual(['dependencies']);
    });

    it('counts a package.json that is new in a workspace package as all new, and skips node_modules', async () => {
      await mkdir(join(dir, 'packages', 'ui'), { recursive: true });
      await writeFile(join(dir, 'packages', 'ui', 'package.json'), pkg({ clsx: '^2.0.0' }));
      await mkdir(join(dir, 'node_modules', 'x'), { recursive: true });
      await writeFile(join(dir, 'node_modules', 'x', 'package.json'), pkg({ sneaky: '1.0.0' }));
      const r = await dependenciesCheck(dir, base, ['packages/ui/package.json', 'node_modules/x/package.json']);
      expect(r.passed).toBe(false);
      expect(r.detail).toContain('New: clsx ^2.0.0 (dependencies in packages/ui/package.json)');
      expect(r.detail).not.toContain('sneaky');
    });

    it('does not count a changed version, or a package moved between sections, as new', async () => {
      await writeFile(join(dir, 'package.json'), pkg({ react: '^19.1.0', vitest: '^4.0.0' }));
      const r = await check();
      expect(r.passed).toBe(true);
      expect(r.detail).toBe('No new packages.\nChanged: react ^19.0.0 → ^19.1.0 (package.json)');
    });
  });
});

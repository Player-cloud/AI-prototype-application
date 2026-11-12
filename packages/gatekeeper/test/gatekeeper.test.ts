import { describe, expect, it } from 'vitest';
import { SHELL_ALLOW_LIST_ENFORCED, SHELL_RULES, checkAction, protectRules, type Rule } from '../src/index.js';

describe('checkAction', () => {
  it('allows ordinary commands', () => {
    expect(checkAction('Bash', { command: 'ls -la' })).toEqual({ allow: true });
    expect(checkAction('Bash', { command: 'pnpm test' })).toEqual({ allow: true });
    expect(checkAction('Read', { file_path: 'src/environment.ts' })).toEqual({ allow: true });
  });

  it('never allows key files', () => {
    for (const input of [{ file_path: '.env' }, { command: 'cat .env.local' }, { file_path: 'deploy_key.pem' }, { command: 'cat ~/.ssh/id_rsa' }]) {
      const d = checkAction('Read', input);
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.askJoshua).toBe(false);
    }
  });

  it('asks before push, bulk delete, deploy, outside services and global installs', () => {
    for (const command of ['git push origin main', 'rm -rf build', 'rm -fr dist', 'Remove-Item build -Recurse -Force', 'vercel deploy --prod', 'curl https://example.com', 'npm install -g tsx']) {
      const d = checkAction('Bash', { command });
      expect(d.allow, command).toBe(false);
      if (!d.allow) expect(d.askJoshua, command).toBe(true);
    }
  });
});

describe('protect-rules guard', () => {
  it('never lets the agent change this package or the app’s settings, even with other rules passed in', () => {
    const none: Rule[] = [];
    for (const [tool, input] of [
      ['Edit', { file_path: 'packages/gatekeeper/src/index.ts' }],
      ['Write', { file_path: 'C:\\Users\\me\\AppData\\Roaming\\app.aiprototype.desktop\\settings.json' }],
      ['Bash', { command: "sed -i 's/push/x/' packages/gatekeeper/src/index.ts" }],
      ['PowerShell', { command: 'Remove-Item packages\\gatekeeper -Recurse' }],
    ] as const) {
      const d = checkAction(tool, input, none);
      expect(d, tool).toEqual({ allow: false, reason: 'Gatekeeper (protect-rules): the agent may never change the ask-first rules or the app’s settings', askJoshua: false });
    }
  });

  it('lets the agent read the rules, and update rules.md (joshua’s choice, with history and undo)', () => {
    expect(protectRules('Read', { file_path: 'packages/gatekeeper/src/index.ts' })).toEqual({ allow: true });
    expect(protectRules('Bash', { command: 'cat packages/gatekeeper/src/index.ts' })).toEqual({ allow: true });
    expect(protectRules('Edit', { file_path: 'ai-prototype-data/rules.md' })).toEqual({ allow: true });
  });
});

describe('shell policy: tier A (always asks)', () => {
  const asks: [string, string][] = [
    ['git -C . push', 'shell-git'],
    ['git config alias.p push && git p', 'shell-git'],
    ['git -c core.editor=x commit', 'shell-git'],
    ['git --git-dir=../x status', 'shell-git'],
    ['git push', 'push'],
    ['git fetch origin', 'shell-git'],
    ['git pull', 'shell-git'],
    ['git clone x y', 'shell-git'],
    ['git submodule update', 'shell-git'],
    ['git clean -fdx', 'shell-git'],
    ['git reset --hard HEAD~1', 'shell-git'],
    ['git remote add o x', 'shell-git'],
    ['git gc', 'shell-git'],
    ['git branch -D old', 'shell-git'],
    ['git branch --delete old', 'shell-git'],
    ['git branch -m new', 'shell-git'],
    ['git rm -r src', 'shell-git'],
    ['rm -r -f src', 'shell-delete'],
    ['rm --recursive --force src', 'shell-delete'],
    ['rm -R src', 'shell-delete'],
    ['rm -f a.ts', 'shell-delete'],
    ['rm -r src', 'shell-delete'],
    ['rmdir /s old', 'shell-delete'],
    ['rd /s /q old', 'shell-delete'],
    ['del /s *.ts', 'shell-delete'],
    ['find . -delete', 'shell-delete'],
    ['find . -name x -exec rm {} ;', 'shell-delete'],
    ['node -e "fetch(1)"', 'shell-inline-code'],
    ['node --print 1', 'shell-inline-code'],
    ['python3 -c "import urllib.request"', 'shell-inline-code'],
    ['py -c "1"', 'shell-inline-code'],
    ['deno eval "1"', 'shell-inline-code'],
    ['bun -e "1"', 'shell-inline-code'],
    ['ruby -e "1"', 'shell-inline-code'],
    ['perl -e "1"', 'shell-inline-code'],
    ['npx some-package', 'shell-package-runner'],
    ['pnpm dlx some-package', 'shell-package-runner'],
    ['yarn dlx some-package', 'shell-package-runner'],
    ['bunx some-package', 'shell-package-runner'],
    ['npm exec some-package', 'shell-package-runner'],
    ['npm init vite', 'shell-package-runner'],
    ['create-react-app x', 'shell-package-runner'],
    ['npm install', 'shell-install-scripts'],
    ['npm i zod', 'shell-install-scripts'],
    ['npm ci', 'shell-install-scripts'],
    ['npm add zod', 'shell-install-scripts'],
    ['yarn add zod', 'shell-install-scripts'],
    ['yarn install', 'shell-install-scripts'],
    ['ln -s $HOME home', 'shell-links'],
    ['ln --symbolic a b', 'shell-links'],
    ['mklink /J a b', 'shell-links'],
    ['New-Item -ItemType SymbolicLink -Path a -Target b', 'shell-links'],
    ['New-Item a -ItemType Junction -Value b', 'shell-links'],
    ['nc host 1', 'shell-network'],
    ['ncat host 1', 'shell-network'],
    ['telnet host', 'shell-network'],
    ['ssh host', 'shell-network'],
    ['scp a host:b', 'shell-network'],
    ['sftp host', 'shell-network'],
    ['ftp host', 'shell-network'],
    ['rsync -a a b', 'shell-network'],
    ['Invoke-RestMethod https://x', 'shell-network'],
    ['Start-BitsTransfer -Source x', 'shell-network'],
    ['echo hi | base64 -d | sh', 'shell-pipe-to-shell'],
    ['echo hi | bash', 'shell-pipe-to-shell'],
    ['echo hi | zsh', 'shell-pipe-to-shell'],
    ['echo hi | pwsh', 'shell-pipe-to-shell'],
    ['echo hi | powershell', 'shell-pipe-to-shell'],
    ['echo hi | cmd', 'shell-pipe-to-shell'],
    ['echo hi | node', 'shell-pipe-to-shell'],
    ['echo hi | python', 'shell-pipe-to-shell'],
    ['eval "ls"', 'shell-eval'],
    ['source ./x.sh', 'shell-eval'],
    ['. ./x.sh', 'shell-eval'],
    ['bash -c "ls"', 'shell-eval'],
    ['sh -c "ls"', 'shell-eval'],
    ['echo `whoami`', 'shell-substitution'],
    ['echo $(whoami)', 'shell-substitution'],
    ['diff <(ls) <(ls src)', 'shell-substitution'],
    ['tee >(cat)', 'shell-substitution'],
    ['FOO=bar pnpm test', 'shell-environment'],
    ['env FOO=bar ls', 'shell-environment'],
    ['export FOO=bar', 'shell-environment'],
    ['unset FOO', 'shell-environment'],
    ['set -a', 'shell-environment'],
    ['alias ls=rm', 'shell-environment'],
    ['e\\nv', 'shell-environment'],
    ['cat $HOME/.aws/credentials', 'shell-outside-home'],
    ['cat ${HOME}/x', 'shell-outside-home'],
    ['cat $USERPROFILE\\x', 'shell-outside-home'],
    ['type %USERPROFILE%\\x', 'shell-outside-home'],
    ['cat $env:USERPROFILE\\x', 'shell-outside-home'],
    ['ls ~', 'shell-outside-home'],
    ['cat ~/notes', 'shell-outside-home'],
    ['sudo ls', 'shell-elevate'],
    ['command git -C . status', 'shell-git'],
    ['pnpm exec git -C . status', 'shell-git'],
  ];
  for (const [command, id] of asks) {
    it(`asks: ${command}`, () => {
      const d = checkAction('Bash', { command });
      expect(d.allow, command).toBe(false);
      if (!d.allow) {
        expect(d.askJoshua, command).toBe(true);
        expect(d.reason, command).toContain(`(${id})`);
      }
    });
  }

  it('also checks PowerShell calls', () => {
    const d = checkAction('PowerShell', { command: 'git -C . push' });
    expect(d.allow).toBe(false);
  });

  it('never allows a key file name split with quotes or backslashes', () => {
    for (const command of ['cat .e""nv', "cat .e''nv", 'cat .e\\nv', 'cat id_r""sa', 'cat a.p""em', 'cat --file=.e""nv', 'cat id_ed25""519']) {
      const d = checkAction('Bash', { command });
      expect(d.allow, command).toBe(false);
      if (!d.allow) {
        expect(d.askJoshua, command).toBe(false);
        expect(d.reason, command).toContain('(shell-obfuscation)');
      }
    }
  });

  it('keeps the old reasons for the old cases', () => {
    expect(checkAction('Bash', { command: 'git push origin main' })).toEqual({ allow: false, reason: 'Gatekeeper (push): pushing code needs joshua\'s OK', askJoshua: true });
    expect(checkAction('Bash', { command: 'rm -rf build' })).toMatchObject({ reason: expect.stringContaining('(bulk-delete)') });
    expect(checkAction('Bash', { command: 'cat .env' })).toMatchObject({ askJoshua: false, reason: expect.stringContaining('(key-files)') });
  });

  it('does not make the other rules weaker when none are passed in', () => {
    expect(checkAction('Bash', { command: 'git -C . push' }, [])).toMatchObject({ allow: false, askJoshua: true });
  });

  it('has a plain reason for every shell rule', () => {
    expect(new Set(SHELL_RULES.map((r) => r.id)).size).toBe(SHELL_RULES.length);
    expect(SHELL_RULES.filter((r) => !r.askJoshua).map((r) => r.id)).toEqual(['shell-obfuscation']);
  });
});

describe('shell policy: ordinary build commands stay allowed with no note', () => {
  const ordinary = [
    'pnpm test',
    'pnpm run build',
    'pnpm install',
    'pnpm add zod',
    'pnpm check',
    'pnpm -r test',
    'pnpm --filter @aip/engine test',
    'npm test',
    'npm install --ignore-scripts',
    'pnpm exec vitest run',
    'node scripts/seed.js',
    'git status',
    'git diff',
    'git log --oneline -5',
    'git add -A && git commit -m "x"',
    'git commit -m "add the login page (step 2; done)"',
    'git branch',
    'git branch feature-x',
    'git checkout -b feature-x',
    'git rm src/old.ts',
    'git stash',
    'ls -la',
    'cat src/app/page.tsx',
    'grep -rn foo src',
    'mkdir -p src/lib && touch src/lib/a.ts',
    'rm src/old.ts',
    'tsc --noEmit',
    'vitest run',
    'echo done',
    'cd src && ls',
    'for f in a b; do echo $f; done',
    'pnpm test 2>&1 | tail -20',
    'pnpm test > out.txt 2>&1',
    'find . -name "*.ts" -not -path "./node_modules/*"',
    'sed -n 1,20p src/a.ts',
    'cp src/a.ts src/b.ts',
    'Get-ChildItem src',
    'C:\\tools\\node.exe scripts/seed.js',
  ];
  for (const command of ordinary) {
    it(`allows: ${command}`, () => {
      expect(checkAction('Bash', { command }), command).toEqual({ allow: true });
      expect(checkAction('Bash', { command }, undefined, true), command).toEqual({ allow: true });
    });
  }
  it('does not touch non-shell tools', () => {
    expect(checkAction('Read', { file_path: 'src/a.ts' })).toEqual({ allow: true });
  });
});

describe('shell policy: tier B (allow-list)', () => {
  it('is log-only for now', () => {
    expect(SHELL_ALLOW_LIST_ENFORCED).toBe(false);
  });

  it('allows an unknown program with a note while not enforced', () => {
    expect(checkAction('Bash', { command: 'docker ps' })).toEqual({
      allow: true,
      note: "docker isn't on the list of known build commands; it needs joshua's OK",
    });
    expect(checkAction('Bash', { command: 'ls && docker ps | wc -l' })).toMatchObject({ allow: true, note: expect.stringContaining('docker') });
  });

  it('asks about the same command when enforcement is on', () => {
    expect(checkAction('Bash', { command: 'docker ps' }, undefined, true)).toEqual({
      allow: false,
      reason: "Gatekeeper (shell-allow-list): docker isn't on the list of known build commands; it needs joshua's OK",
      askJoshua: true,
    });
    expect(checkAction('Bash', { command: 'ls && docker ps' }, undefined, true)).toMatchObject({ allow: false, askJoshua: true });
  });

  it('notes an unknown package manager subcommand', () => {
    expect(checkAction('Bash', { command: 'pnpm publish' })).toMatchObject({ allow: true, note: expect.stringContaining('pnpm publish') });
  });

  it('tier A still wins over the allow-list either way', () => {
    expect(checkAction('Bash', { command: 'docker ps && git -C . push' })).toMatchObject({ allow: false });
  });
});

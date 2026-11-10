import { describe, expect, it } from 'vitest';
import { checkAction } from '../src/index.js';

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

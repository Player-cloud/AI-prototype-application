#!/usr/bin/env node
/**
 * Stage R2: checks a pack made by scripts/bundle-engine.mjs the way the installed app uses it.
 * Starts <dir>/engine/dist/helper.js with <dir>/node/node(.exe), with <dir>/node (and <dir>/git/cmd) first on PATH,
 * and asks the engine for ping, settings_check and environment_check (all free, no network).
 *
 * Usage: node scripts/smoke-bundle.mjs <dir>
 * Exits 1 with a plain reason when anything is wrong.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(process.argv[2] ?? join(ROOT, 'apps', 'desktop', 'src-tauri', 'bundle-resources'));
const node = join(dir, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
const helper = join(dir, 'engine', 'dist', 'helper.js');
const TC = JSON.parse(readFileSync(join(ROOT, 'toolchain.json'), 'utf8'));
const want = TC.node.version;

const fail = (why) => {
  console.error(`Pack check FAILED: ${why}`);
  process.exit(1);
};

// The same as the shell does: the bundled Node's folder first on PATH. Run from outside the repo.
const gitCmd = join(dir, 'git', 'cmd');
const bundledGit = existsSync(gitCmd);
const env = { ...process.env, PATH: [dirname(node), ...(bundledGit ? [gitCmd] : []), process.env.PATH ?? ''].join(delimiter) };
const child = spawn(node, [helper], { cwd: dirname(dir), env, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
child.on('error', (e) => fail(`could not start ${node}: ${e.message}`));
const timer = setTimeout(() => fail('no answer from the engine in 60 seconds'), 60_000);

const asks = [
  { id: 1, method: 'ping' },
  { id: 2, method: 'settings_check', params: { settings: {} } },
  { id: 3, method: 'environment_check', params: { settings: {} } },
];
const replies = new Map();
createInterface({ input: child.stdout }).on('line', (line) => {
  const r = JSON.parse(line);
  if (r.error) fail(`${asks.find((a) => a.id === r.id)?.method}: ${r.error}`);
  replies.set(r.id, r.result);
  if (replies.size < asks.length) return;
  clearTimeout(timer);
  child.stdin.end();
  const versions = replies.get(3).environment.versions;
  if (replies.get(1).ok !== true) fail('ping did not answer ok');
  if (versions.node !== want) fail(`the engine ran on Node ${versions.node}, not the bundled ${want}`);
  if (!versions['claude-agent-sdk']) fail('the Claude Agent SDK was not found in the pack');
  if (versions.pnpm !== TC.pnpm.version) fail(`the engine found pnpm "${versions.pnpm}", not the bundled ${TC.pnpm.version}`);
  if (bundledGit && !TC.mingit.version.startsWith(versions.git)) fail(`the engine found git "${versions.git}", not the bundled ${TC.mingit.version}`);
  console.log(`Pack check passed: engine ${replies.get(1).version} on bundled Node ${versions.node}, pnpm ${versions.pnpm}, git ${versions.git}${bundledGit ? ' (bundled)' : " (this PC's)"}, Agent SDK ${versions['claude-agent-sdk']}, from ${dir}`);
});
for (const a of asks) child.stdin.write(`${JSON.stringify(a)}\n`);

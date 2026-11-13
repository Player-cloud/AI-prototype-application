#!/usr/bin/env node
/**
 * Stage R2: packs what the installed app needs to run its engine, so a PC needs no Node and no
 * source folder. Writes, next to where the app's program will be installed:
 *
 *   <out>/engine/   the built engine with only its production packages (no symlinks)
 *   <out>/node/     node(.exe) and a `pnpm` launcher
 *   <out>/pnpm/     the pnpm package
 *   <out>/git/      MinGit (Windows only)
 * Each tool is pinned in toolchain.json and checked against its SHA-256.
 *
 * The shell (src-tauri/src/engine.rs) looks for these folders next to its own program and puts
 * node/ and git/cmd/ first on PATH.
 *
 * Usage: node scripts/bundle-engine.mjs [--out <dir>] [--platform win-x64|linux-x64] [--no-tools]
 * Downloads go to .toolchain-cache/ and are reused once their SHA-256 matches.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const OUT = resolve(opt('--out', join(ROOT, 'apps', 'desktop', 'src-tauri', 'bundle-resources')));
const PLATFORM = opt('--platform', process.platform === 'win32' ? 'win-x64' : 'linux-x64');
const WITH_NODE = !args.includes('--no-tools');
const isWin = process.platform === 'win32';

const run = (cmd, cmdArgs, cwd = ROOT) => execFileSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: isWin });
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Folder size in bytes (files only). */
function size(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? size(p) : statSync(p).size;
  }
  return total;
}
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

/** Engine: built, then deployed with production packages only, as plain folders. */
function bundleEngine() {
  const dest = join(OUT, 'engine');
  rmSync(dest, { recursive: true, force: true });
  run('pnpm', ['exec', 'tsc', '-b', 'packages/engine']);
  // "hoisted" gives real folders instead of links, which installers copy reliably on Windows.
  run('pnpm', ['--filter', '@aip/engine', 'deploy', '--prod', '--legacy', '--config.node-linker=hoisted', dest]);
  // The installed app only runs dist/: drop sources, tests and build files from our own packages.
  const ours = [dest, ...readdirSync(join(dest, 'node_modules', '@aip')).map((n) => join(dest, 'node_modules', '@aip', n))];
  for (const dir of ours) {
    for (const junk of ['src', 'test', 'tsconfig.json', 'tsconfig.tsbuildinfo']) rmSync(join(dir, junk), { recursive: true, force: true });
  }
  rmSync(join(dest, 'node_modules', '.bin'), { recursive: true, force: true }); // command links, not used by the app
  if (!existsSync(join(dest, 'dist', 'helper.js'))) throw new Error('engine/dist/helper.js is missing after the build');
  return size(dest);
}

const TOOLCHAIN = JSON.parse(readFileSync(join(ROOT, 'toolchain.json'), 'utf8'));
const CACHE = join(ROOT, '.toolchain-cache');

/** Downloads `file.url` once into the cache and refuses it unless its SHA-256 is the pinned one. */
async function fetchChecked(file) {
  mkdirSync(CACHE, { recursive: true });
  const archive = join(CACHE, file.url.split('/').pop());
  if (!existsSync(archive) || sha256(archive) !== file.sha256) {
    console.log(`Downloading ${file.url}`);
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${file.url}`);
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  }
  const got = sha256(archive);
  if (!file.sha256) throw new Error(`No SHA-256 is pinned for ${file.url} in toolchain.json. This download's is ${got}: check it against the official release page before pinning it.`);
  if (got !== file.sha256) throw new Error(`SHA-256 mismatch for ${archive}: expected ${file.sha256}, got ${got}. Not used.`);
  return archive;
}

/** Unpacks `archive` (zip, tar.gz or tar.xz) into a fresh folder; `only` limits it to one member. */
function unpack(archive, into, only) {
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  const member = only ? [only] : [];
  if (archive.endsWith('.zip')) {
    // Windows 10/11 tar reads zip files; elsewhere use unzip.
    if (isWin) run('tar', ['-xf', archive, '-C', into, ...member]);
    else run('unzip', ['-q', archive, ...member, '-d', into]);
  } else {
    run('tar', [archive.endsWith('.xz') ? '-xJf' : '-xzf', archive, '-C', into, ...member]);
  }
}

/** Node: only the program is copied. */
async function bundleNode() {
  const file = TOOLCHAIN.node.files[PLATFORM];
  if (!file) throw new Error(`toolchain.json has no Node for ${PLATFORM}`);
  const archive = await fetchChecked(file);
  const tmp = join(CACHE, `unpacked-node-${PLATFORM}`);
  unpack(archive, tmp, file.program);
  const dest = join(OUT, 'node');
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const name = PLATFORM.startsWith('win') ? 'node.exe' : 'node';
  cpSync(join(tmp, file.program), join(dest, name));
  return statSync(join(dest, name)).size;
}

/**
 * pnpm: its JavaScript package, run by the bundled Node. A small launcher named `pnpm` goes next to
 * node(.exe), so `pnpm` on PATH works for the engine and for every build.
 */
async function bundlePnpm() {
  const archive = await fetchChecked(TOOLCHAIN.pnpm);
  const tmp = join(CACHE, 'unpacked-pnpm');
  unpack(archive, tmp);
  const dest = join(OUT, 'pnpm');
  rmSync(dest, { recursive: true, force: true });
  cpSync(join(tmp, 'package'), dest, { recursive: true });
  const nodeDir = join(OUT, 'node');
  mkdirSync(nodeDir, { recursive: true });
  if (PLATFORM.startsWith('win')) {
    writeFileSync(join(nodeDir, 'pnpm.cmd'), '@"%~dp0node.exe" "%~dp0..\\pnpm\\bin\\pnpm.cjs" %*\r\n');
  } else {
    writeFileSync(join(nodeDir, 'pnpm'), '#!/bin/sh\nd=$(dirname "$0")\nexec "$d/node" "$d/../pnpm/bin/pnpm.cjs" "$@"\n', { mode: 0o755 });
  }
  return size(dest);
}

/** git: MinGit, Git for Windows' cut-down git for apps. Windows only; elsewhere the PC's git is used. */
async function bundleGit() {
  const file = TOOLCHAIN.mingit.files[PLATFORM];
  if (!file) return 0;
  const archive = await fetchChecked(file);
  const dest = join(OUT, 'git');
  unpack(archive, dest);
  if (!existsSync(join(dest, 'cmd', 'git.exe'))) throw new Error('MinGit has no cmd/git.exe');
  return size(dest);
}

const engineBytes = bundleEngine();
const sizes = WITH_NODE ? { node: await bundleNode(), pnpm: await bundlePnpm(), git: await bundleGit() } : {};
console.log(`\nPacked into ${OUT} (${PLATFORM})`);
console.log(`  engine: ${mb(engineBytes)}`);
for (const [k, v] of Object.entries(sizes)) console.log(`  ${k.padEnd(6)}: ${v ? mb(v) : 'not bundled on this platform'}`);

#!/usr/bin/env node
/**
 * Stage R2: packs what the installed app needs to run its engine, so a PC needs no Node and no
 * source folder. Writes, next to where the app's program will be installed:
 *
 *   <out>/engine/   the built engine with only its production packages (no symlinks)
 *   <out>/node/     node(.exe), pinned in toolchain.json and checked against its SHA-256
 *
 * The shell (src-tauri/src/engine.rs) looks for exactly these two folders next to its own program.
 *
 * Usage: node scripts/bundle-engine.mjs [--out <dir>] [--platform win-x64|linux-x64] [--no-node]
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
const WITH_NODE = !args.includes('--no-node');
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

/** Node: downloaded once, checked against toolchain.json, and only the program copied. */
async function bundleNode() {
  const tc = JSON.parse(readFileSync(join(ROOT, 'toolchain.json'), 'utf8'));
  const file = tc.node.files[PLATFORM];
  if (!file) throw new Error(`toolchain.json has no Node for ${PLATFORM}`);
  const cache = join(ROOT, '.toolchain-cache');
  mkdirSync(cache, { recursive: true });
  const archive = join(cache, file.url.split('/').pop());
  if (!existsSync(archive) || sha256(archive) !== file.sha256) {
    console.log(`Downloading ${file.url}`);
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${file.url}`);
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  }
  const got = sha256(archive);
  if (got !== file.sha256) throw new Error(`SHA-256 mismatch for ${archive}: expected ${file.sha256}, got ${got}. Not used.`);
  const unpack = join(cache, `unpacked-${PLATFORM}`);
  rmSync(unpack, { recursive: true, force: true });
  mkdirSync(unpack, { recursive: true });
  if (archive.endsWith('.zip')) {
    // Windows 10/11 tar reads zip files; elsewhere use unzip.
    if (isWin) run('tar', ['-xf', archive, '-C', unpack, file.program]);
    else run('unzip', ['-q', archive, file.program, '-d', unpack]);
  } else {
    run('tar', ['-xJf', archive, '-C', unpack, file.program]);
  }
  const dest = join(OUT, 'node');
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const name = PLATFORM.startsWith('win') ? 'node.exe' : 'node';
  cpSync(join(unpack, file.program), join(dest, name));
  return statSync(join(dest, name)).size;
}

const engineBytes = bundleEngine();
const nodeBytes = WITH_NODE ? await bundleNode() : 0;
console.log(`\nPacked into ${OUT}`);
console.log(`  engine: ${mb(engineBytes)}`);
if (WITH_NODE) console.log(`  node:   ${mb(nodeBytes)} (${PLATFORM})`);

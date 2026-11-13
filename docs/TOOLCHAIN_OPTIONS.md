# Bundling git, Node and pnpm (decision Q5)

**Status:** options compared for stage R0, 13 Nov 2026. Nothing is built yet: the work is stage R2 (engine and Node) and R3 (git, pnpm, setup).
**Decision (joshua, 13 Nov):** the Windows installer bundles git, Node and pnpm. This file looks at how to keep that small, easy to install and easy to change.

Sizes marked **measured** were read from the official download servers on 13 Nov 2026 (file size only, nothing downloaded or run). Sizes marked **approx.** are estimates and must be measured in R2.

## What the app needs, and why

| Tool | Used by | Today |
| --- | --- | --- |
| Node | The engine helper (`packages/engine/dist/helper.js`), the Claude Agent SDK, Playwright, and each built project's tests and dev server | Must already be installed; found on PATH |
| pnpm | Installing and testing each built project (`checks/src/tests.ts`), `pnpm audit`, `pnpm outdated` | Must already be installed |
| git | Worktrees for every build, Keep, Undo, revert, data-repo sync | Must already be installed, with a name and email set |
| Edge | Pictures and accessibility checks | Already part of Windows 10/11: no bundling needed |

## Options per tool

### Node

| Option | Size | Easy to change? | Notes |
| --- | --- | --- | --- |
| **A. Official Node zip, `node.exe` only, as a Tauri resource** (recommended) | Node 24 win-x64: zip 37.8 MB, 7z 23.8 MB (**measured**, v24.22.3). `node.exe` alone is most of that | Yes: one version line in a manifest | One `node.exe` serves the engine **and** the builds, so it is shipped once |
| B. Node single executable (SEA) for the engine | About the same as A, plus the engine | Harder: rebuilt for every change | Still needs a plain `node.exe` for builds, so it adds size instead of saving it |
| C. Bun or Deno instead of Node | approx. 60–110 MB | Medium | Not drop-in: the Agent SDK, Next.js and pnpm projects are tested on Node. Not recommended |

`node:sqlite` still prints "experimental" on Node 22.23 (seen in `pnpm check` on 13 Nov). R2 must confirm it behaves the same on the bundled version.

### pnpm

| Option | Size | Notes |
| --- | --- | --- |
| **A. The pnpm JavaScript package, run by the bundled `node.exe`** (recommended) | pnpm 10.34.9 unpacked: 20.0 MB (**measured**, npm registry). pnpm 12: 4.4 MB | Smallest. The app calls `node pnpm.cjs` instead of `pnpm` |
| B. pnpm's own Windows `.exe` (`@pnpm/win-x64`) | 100.2 MB unpacked (**measured**) | Contains its own Node, so it duplicates option A's Node |
| C. Corepack | 0 MB extra | Not reliable: newer Node releases are dropping it. Not recommended |

### git

| Option | Size | Notes |
| --- | --- | --- |
| **A. MinGit for Windows** (recommended) | approx. 35–40 MB zip (could not be measured from here) | Official cut-down git for apps to embed. Full git commands, including worktrees |
| B. A pure-JavaScript git (isomorphic-git) | approx. 1 MB | No `git worktree`, which every build uses. Not usable without a redesign |
| C. libgit2 in the Rust shell | approx. 2–5 MB | Large rewrite of every git call. Not worth it for the evaluation |

## Ways to make it smaller, easier and easy to change

1. **Ship one Node for everything.** The engine and the builds share one `node.exe`, and pnpm runs on it. This avoids two or three copies.
2. **One manifest file, `toolchain.json`, in the repo.** It holds each tool's version, download address and SHA-256. A build script fetches, checks and unpacks them into `src-tauri/resources/` before `tauri build`. Changing a version means editing one line and rebuilding, with no code changes. The app's existing update look-up (CI-6) can read the same file and say when a newer version is out.
3. **The app always uses its own copies.** The engine puts its bundled `node`, `pnpm` and `git` first on PATH for builds, so a different version on the PC can't break a build. The environment check (CI-2) reports the bundled versions.
4. **git setup without a terminal.** The app sets the commit name and email for the build copies itself, using the name entered at first run, with no `git config --global`.
5. **Strong compression.** NSIS with LZMA compresses these tools well. The installer estimate was **approx. 70–100 MB** in total. **Update, 13 Nov (R2 trial):** the Claude Agent SDK brings its own 345 MB program, so the estimate is now **about 180–200 MB**; see [evidence/2026-11-13-r2-spike.md](evidence/2026-11-13-r2-spike.md).
6. **Keep both installer types.** `.exe` (NSIS) installs per user without admin rights, which suits individual evaluators. `.msi` lets company IT deploy to many PCs at once (Intune, Group Policy), which fits "any team size". Both use the same bundled tools.
7. **Later, if size matters more than offline use:** a small installer (approx. 15 MB) that downloads the tools on first run from the official servers, checked against `toolchain.json`. This needs internet at first run and adds outside services, so it needs joshua's OK. It is not recommended for the evaluation.

## Recommendation

Bundle `node.exe` (Node 24 LTS), the pnpm JavaScript package and MinGit as Tauri resources, pinned by `toolchain.json` with SHA-256 checks, and use them first on PATH for every build. This meets Q5 with one place to change versions and an estimated 70–100 MB installer.

## Licences to check before shipping (R6)

Node (MIT plus bundled third-party licences), pnpm (MIT) and Git for Windows (GPL v2) all allow redistribution. The GPL needs the licence text included and the source made available. This must go through the licence review in R6, not be assumed here.

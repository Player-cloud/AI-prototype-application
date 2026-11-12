# Current-state audit

**Date:** 2026-11-12
**Repo:** `Player-cloud/AI-prototype-application`, branch `main` at `99ac216` (merge of PR #56). The previous version of this audit described `c2b3fcf` (11 Nov, step 6b).
**Data repo:** `Player-cloud/ai-prototype-data`. Not visible from here. Anything below that comes from it is marked "given" (told to this audit by joshua's records, not re-read).
**Authority:** the Claude Doc "AI-prototype-application: full plan" (10 Nov 2026). Where anything below differs from it, the plan wins.
**Related:** [System architecture](SYSTEM_ARCHITECTURE.md) · [Product requirements](PRODUCT_REQUIREMENTS.md)

This file is read-only evidence. It says what the code does today, not what it should do. Every status below was checked by reading the code. A merged PR alone never counts as "done".

## Evidence labels (the same in all three docs)

| Label | Means |
| --- | --- |
| **Verified** | Code + tests + real-use evidence |
| **Implemented** | Code + unit tests, no real-use proof yet |
| **Partial** | Some of it is built; the rest is not |
| **Missing** | Not in the code |
| **Planned** | In the roadmap, not started |

**Real-use evidence that exists (given, from the private data repo):**

- The first real build, Club HR F-01, passed on 12 Nov (cost £0.09 / $0.11).
- The free tests (CI-3) for secretlint, axe-core, playwright and checklist-rules passed on one computer.
- The environment check (CI-2) ran on one computer.
- Update look-up (CI-6) ran, and 9 updates were OK'd.
- **No real-use record yet:** the phone flows, the live view, CI-4, CI-5, CI-7, CI-8.

---

## 1. What was inspected

| Area | Where |
| --- | --- |
| Tree, manifests, lockfile | `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig*.json`, `vitest.config.ts` |
| Rust shell | `apps/desktop/src-tauri/src/{lib,engine,keys,settings}.rs` |
| Screens | `apps/desktop/src/**` (Projects, Build, Tools, Capability Centre, Settings; Needs you and History panels) |
| Engine | `packages/engine/src/*` |
| Models | `packages/models/src/*` (claude, openai-compatible, causes) |
| Tools | `packages/tools/src/index.ts` |
| Memory | `packages/memory/src/*` |
| Checks | `packages/checks/src/*` |
| Gatekeeper | `packages/gatekeeper/src/index.ts` (read only) |
| CI | `.github/workflows/ci.yml`, `.github/workflows/shell.yml` |
| History | `git log origin/main` (PRs #1 to #56) |

**Test counts (run on 12 Nov at `99ac216`):**

- `pnpm install --frozen-lockfile && pnpm test`: **605 TypeScript tests passed, in 68 files, 0 failed.** The first run, straight after install, failed with "Failed to resolve entry for package @aip/tools", because the packages' compiled output didn't exist yet. After `pnpm typecheck` (which builds it) all 68 files ran. CI and `pnpm check` run typecheck first, so this only matters for a fresh checkout.
- **22 Rust tests** (`#[test]`: engine.rs 8, keys.rs 6, lib.rs 5, settings.rs 3). Counted, not run here: there is no Rust toolchain in this environment.
- The audit of 11 Nov counted about 153 TypeScript tests in 27 files and 16 Rust tests.

**Not done here:** the app was not launched. Real-use evidence comes only from the given list above.

## 2. Where the architecture and PRD live

- The plan lives in the Claude Doc. This repo holds `docs/SYSTEM_ARCHITECTURE.md` and `docs/PRODUCT_REQUIREMENTS.md` under it, plus this audit. They don't compete with the plan.
- The old repo `Player-cloud/aPP-claude` (`docs/spec/*`, 27 Oct 2026) describes the old Electron app. It is superseded and not edited.

## 3. V1 progress (eleven steps)

### Step 1. Tool trials (cloud): **Verified**
- **Evidence:** `ai-prototype-data/trials/*` and 25 ledger lines with 10 tool cards (given). Trials were screening runs (1 to 3 per job).
- **Still open:** the EGM ledger line in the data repo (D-1) can't be checked from here. Desktop Commander, Claude in Chrome and computer use were "NOT TESTED".
- **D-2 baseline and stale rule:** now in code (CI-1, see §4). The code marks a tool's old results stale when its version changes and clears the mark on a good run.

### Step 2. Repo setup: **Partial**
- Setup itself is Verified: pnpm 10 monorepo, `CLAUDE.md`, typecheck, tests, secretlint, `pnpm audit`.
- **CI is not running.** GitHub Actions jobs were not started from 11 Nov 19:12 UTC because of account billing. Branch protection isn't available on a private repo on the free plan, so checks can't be made required. Until Actions runs again the only gate is the local `pnpm check`, and everything merged since then has no CI result.
- PR #49 repaired the workflow (see §4.2), but the repair has not run on GitHub yet.

### Step 3. Window and screens: **Verified**
- Tauri 2 shell, React rail (Projects, Build, Tools, Capability Centre, Settings), engine helper over JSON lines, keys in the OS password store (Windows Credential Manager, Linux Secret Service). Confirmed on joshua's Windows laptop on 10 Nov.
- Bundling Node into the installer is still deferred.

### Step 4. Model adapter: **Verified** for Claude; **Implemented** for OpenAI and DeepSeek
- Claude: Agent SDK, tools allowed when building, cost cap, allow-listed environment. Used in the real build.
- OpenAI and DeepSeek: one plain `fetch` adapter, one turn, no tools. `adapter.build` exists only for Claude, so **building needs Claude** (the engine says so). Real-key runs: no record.

### Step 5. Memory and data repo: **Implemented**
- Built and tested: summaries first, ledger, habits, rules and cards load; spend and change history in `history.sqlite`; ratings; git sync that never forces and refuses key-shaped text; tool health records (D-2); evaluation, experiment, update, environment and project-tool records.
- The `Using:` line is now used: `build.ts` shows it at the start of each build.
- Sync after each task is wired (`syncAfter` in `build.ts`, after Keep, Undo and ratings too).
- Parts exercised in real use through CI-2, CI-3 and CI-6 runs (records saved and synced from one computer). The ledger rating and habit learning have no real-use record.
- **Missing:** `[[links]]` aren't in the data repo notes, so graph-following isn't used in practice. The app does **not** write `rules.md` at all (see §4.1, D-3).

### Step 6. Gatekeeper and undo: **Implemented**, with the gatekeeper now in the path of every build tool call
- `packages/gatekeeper` now holds the protect-rules guard (`protectRules`, always first), six ask/never rules, 14 shell rules, and a shell allow-list in log-only mode. See §4.1.
- `engine/gate.ts` only adds joshua's own Settings rules.
- Every tool call of a build goes through it (hook plus `canUseTool`, §4.1).
- Undo: the `changes` table (keeps 200) gives one-click Undo/Redo for settings, data-folder files and project tool choices. CI-8 added a check that the undo really worked.
- Gaps: no real-use record of the rules refusing something in a live build. There is still no switch to turn a tool on and off as an undoable change (switching a model back on is a separate button). Project files are undone by dropping the build's copy.

### Step 7. Plan interview: **Implemented** (the part used by the real build is **Verified**)
- Seven stages, spec and done files written to `projects/<slug>/` (7a). Claude's suggestions with the "plan" job (7b). Plan review, and three fresh-eyes reviews for big builds (7c). The app can make a new code folder for a project.
- The real build of F-01 needed a finished plan and done file, so the interview and spec path is in real use. The suggestions (7b) and reviews (7c) have no separate real-use record.

### Step 8. Build loop: **Verified** for one real build; fix attempts and switch-off are **Implemented**
- Each feature builds in its own git worktree (8a), by the build model with every step checked (8b), a live step list and Stop (8c), then the project's tests with up to 2 fix attempts and the 3-failures switch-off (8d).
- Real use: F-01 passed on 12 Nov. No record of a fix attempt, a Stop, or a switch-off in real use.
- Failed builds are **not** saved as run records (a failed model run throws before the run is written). See §5.

### Step 9. Check, preview and report: **Verified** for tests, free checks and pictures; Keep, Undo, rating and learning are **Implemented**
- Free checks after each build: secrets, audit, **new packages** (needs joshua's OK), checklist rules (advice). Desktop and phone pictures with the browser already on the PC, axe and phone width (advice).
- The first real run found two bugs in the pictures and the audit for npm projects; they were fixed (PR #35). That is real-use evidence for those parts.
- Keep (merge into joshua's own copy, never a push), Undo, 1 to 5 rating per build, habit learning (9d, only the app's own section of `habits.md`, with history and Undo): code and tests, no real-use record given.
- V2 B (honest report): the summary's claims are set beside the app's own results. Implemented, no real-use record.

### Step 10. Phone messages: **Implemented**
- GitHub token in the password store (10a), work items and issues on the data repo plus the Needs you panel (10b), Keep, Undo and rating from the phone (10c). V2 D: start a build from the phone, the model's questions, pictures on the phone.
- No real-use record yet for any phone flow.

### Step 11. First real run: **Partial**
- Club HR F-01 built and passed on 12 Nov (£0.09 / $0.11). Which computer it ran on isn't in the given evidence.
- Not shown yet: every one of the eight task steps with real evidence, and the Linux check (needs a Linux machine).

### V2 work since step 6b

| Item | Label | Note |
| --- | --- | --- |
| V2 A, live view (#36) | **Implemented** | Runs the build copy's own page on 127.0.0.1. No real-use record. |
| V2 B, honest report (#37) | **Implemented** | See step 9. |
| CI-1 stable IDs, versions, stale (#38) | **Implemented** | Card file name is the ID. |
| CI-2 compatibility per computer (#39) | **Verified** | Ran on one computer. A second computer isn't compared yet. |
| CI-3 repeatable free tests (#40) | **Verified** | secretlint, axe-core, playwright, checklist-rules passed on one computer. |
| CI-4 workflow comparisons (#41) | **Implemented** | Advice only. No real-use record. |
| CI-5 experiments (#42) | **Implemented** | Saved as proposals. No real-use record. |
| CI-6 update look-up (#45) | **Verified** | Ran; 9 updates OK'd. The app never installs one. |
| CI-7 tools per project, docs reading (#46) | **Implemented** | No real-use record. |
| CI-8 going back, checking it worked (#47) | **Implemented** | No real-use record. |
| Phone D (#43, #44) | **Implemented** | No real-use record. |
| Capability Centre (#48) | **Implemented** | Shows real records only. No real-use record. |

**Summary:** steps 1, 3, 4 (Claude), the build path of 7, 8 and 9, and CI-2, CI-3, CI-6 have real-use evidence. Phone flows, live view, CI-4, CI-5, CI-7 and CI-8 have none. Step 2's CI is stopped.

## 4. What was built after the first audit

### 4.1 Gatekeeper and build-agent safety (Phase 0, PRs #49 to #56)

These were the audit's first fixes, all merged on 12 Nov.

| PR | What it does | Label |
| --- | --- | --- |
| #49 | CI repair: Ubuntu pinned to `ubuntu-24.04` (not `latest`), job time limits, the Rust shell job moved to its own workflow that runs only when `apps/desktop/src-tauri` changes | **Implemented** (not run on GitHub yet) |
| #50 | Build agent sandbox: its own empty home folder, no git login, `git push` blocked through `GIT_CONFIG_*` settings that beat the repo's own config. Local commits still work | **Implemented** |
| #51 | A PreToolUse hook on every build tool call (blocks if the check fails), beside `canUseTool`, plus a real-path check that follows links for file paths | **Implemented** |
| #52 | Installs for tests run with `--ignore-scripts` | **Implemented** |
| #53 | New packages a build adds need joshua's OK before Keep (the "New packages" check, and "Approve new packages") | **Implemented** |
| #54 | Gatekeeper shell rules: 14 enforced ask/never rules, plus an allow-list of known build programs in **log-only mode** (`SHELL_ALLOW_LIST_ENFORCED = false`). Approved by joshua (Q-2) | **Implemented** (allow-list **Partial**: logs only) |
| #55 | Ask rules really ask: a refused ask-first step goes to Needs you with the exact command; Allow once or No; single use, good for 24 hours; both recorded in History | **Implemented** |
| #56 | Q-3: only the model's own failures count towards the 3-failure switch-off. Causes: model, budget, network, provider, setup, stopped, unknown. Only "model" (and a tool's own fault) counts | **Implemented** |

**Gatekeeper, as it is now (corrects the 11 Nov audit):**

- The protect-rules guard now lives in `packages/gatekeeper` (`protectRules`). `checkAction` always runs it first, whatever rules are passed in. `engine/gate.ts` only adds joshua's own ask-first rules from Settings. (D-3 is done in code.)
- `rules.md` is **not** guarded (D-3, Option A). The app doesn't write `rules.md` yet. `habits.md` writes (the app's own section only) keep history, can be undone, and joshua is told.
- Tests: `packages/gatekeeper/test` (273 lines) and engine gate and build tests cover the rules. No real-use record of a refusal yet.

**Approved engine actions (done by the engine itself, outside the Gatekeeper, by design):**

1. Data-repo commit and push after tasks (F3): `syncDataRepo` pulls with rebase, then pushes, never forces, and refuses key-shaped text.
2. GitHub issues for phone messages, with the fine-grained token from the password store (Issues on the data repo only).
3. `pnpm outdated` look-ups (CI-6). Only package names go to the registry. Nothing is installed.
4. Package installs with `--ignore-scripts` for tests.
5. The live dev server and the picture server on 127.0.0.1 only.

**Still open:**

- The shell allow-list only logs. joshua flips the switch after 3 real builds.
- Windows is untested for the sandbox environment and for links and junctions.
- The real-path check covers file paths only. A shell command gets the word check, plus the link-making shell rule.

### 4.2 CI

- `ci.yml` (typecheck, tests, secretlint, `pnpm audit`, on `ubuntu-24.04` and `windows-latest`, 20-minute limit) and `shell.yml` (Rust `cargo test` on both, only when the shell changes, 30-minute limit).
- **No GitHub Actions job has started since 11 Nov 19:12 UTC (account billing).** Branch protection can't be used on a private repo on the free plan, so the checks can't be required. Until Actions runs again, the only gate is `pnpm check` on the computer that pushes. CI-green is not evidence for anything after step 9a.

## 5. Existing systems and who owns them

| Job | Exists? | Where | Owner from now on |
| --- | --- | --- | --- |
| Tool/capability registry | **Implemented** | `ledger.md` + `tools/<name>.md`, joined by the card file name as a stable ID (CI-1) | **memory** (storage), card format in **tools** |
| Model selection | **Verified** | `CLAUDE_MODEL_BY_JOB`, `pickModel`; build model is Sonnet | **engine** decides; **models** holds defaults |
| Tool selection, lazy loading | **Partial** | The engine picks one build model; tools per project are chosen by joshua (CI-7) | **engine** + **tools** |
| Tool trials / evaluation | **Verified** (CI-3, one computer) | `checks/evals.ts`, results in `evaluations/` | **checks** runs, **memory** stores |
| Agent orchestration | **Verified** (one build) | `engine/build.ts` | **engine** only |
| Memory, ledger, habits, rules, graph | **Implemented** | `packages/memory` | **memory** |
| User ratings | **Implemented** | per tool (`ledger.md`) and per build (`runs`) | **memory** |
| Keep/Undo decision | **Implemented** | `checks.canKeep` + `engine/keep.ts` + `runs` table | **checks** rule, **engine** flow, **memory** record |
| Token and cost records | **Verified** | `spend` table | as before |
| Budget stop | **Implemented** | `engine/budget.ts` (£20, 30% rule, run limit £0.80 default) | **engine** |
| £/$ conversion | **Implemented** | fixed rate in Settings (0.79 default) | **engine** |
| Compatibility checks | **Verified** (one computer) | `checks/environment.ts` (CI-2) | **checks** + **memory** |
| Dependency risk | **Implemented** | audit, secretlint, new-packages check | **checks** |
| Tool conflicts / duplicates | **Partial** | duplicates and clashes listed in the data overview (CI-2); no test of a clash | **memory** data, **checks** test |
| Security and permissions | **Implemented** | see §4.1 | **gatekeeper** = rule source; **engine** applies |
| Key protection | **Verified** (keys), **Implemented** (rest) | OS keyring, env allow-list, sandbox home, key-shape check before sync, secretlint | each point stays where it is |
| Workflow execution | **Verified** (one build) | `engine/build.ts` | **engine** |
| Test execution and reports | **Verified** | `checks/tests.ts` for built projects | **checks** |
| Version tracking | **Implemented** | tool health records (CI-1) | **memory** |
| Update watching | **Verified** | CI-6 look-up; joshua installs by hand | **checks** finds, **memory** stores |
| Undo and recovery | **Implemented** | `ChangeLog`, worktrees, CI-8 checks | **memory** + **engine** |
| Project context, specs | **Verified** (F-01) | `projects/<slug>/` | **memory** stores, **engine** uses |
| Run records | **Implemented** (#57) | `runs` row made at build start (its id is the build ID, also on spend rows); ends as built, failed (with cause), stopped or interrupted | **memory** |

### 5.1 Overlaps and conflicts found

1. **Two places say which model does which job** (`CLAUDE_MODEL_BY_JOB` and `rules.md`). They agreed on 11 Nov. Not re-checked against the data repo.
2. **The job list is written twice** (`engine/protocol.ts` and `models`). Small tidy-up.
3. **Provider display names are written twice.** Cosmetic.
4. **The registry's fuzzy name match** now has a stable ID (the card file name, CI-1). Resolved.
5. **The gatekeeper split across two places.** Resolved by D-3 (see §4.1).
6. **The gatekeeper not in the path of any agent action.** Resolved: every build tool call goes through it.
7. **The EGM ledger line** (D-1): can't be checked from here.
8. **Principles with no build step** (3 failures, stale on update, habits). Resolved by D-2; all three are in code.
9. **The £/$ rate is fixed** (Settings, default 0.79) because a live lookup would be a new outside service. Reports show the rate used.
10. **The old Electron spec docs** are superseded.

No duplicate engine, database, test runner or approval authority was found. `history.sqlite` is the one local database. Its tables are now `spend`, `changes`, `runs`, `work_items`, `asks` and `ask_approvals`.

## 6. Decisions for joshua

- **D-1. Decided (11 Nov):** EGM is "ON for big builds". The data repo's ledger edit can't be confirmed from here.
- **D-2. Decided (11 Nov):** the stale rule, tool health, 3-failures switch-off and habit learning are spread over steps 1, 5, 8 and 9. All four are now in code (CI-1, `memory/health.ts`, `engine/build.ts`, `engine/learn.ts`). Switching off never uninstalls.
- **D-3. Decided (11 Nov), done in code:** the protect-rules guard moved into `packages/gatekeeper` (`protectRules`). Scope (Option A): it protects the gatekeeper package and `settings.json`. `rules.md` isn't guarded; the app may update it and tell joshua, with history and Undo. The app doesn't write `rules.md` yet. Habits writes already have history, Undo and a notice.
- **D-4. Decided (11 Nov):** docs PRs are separate from code PRs.
- **Q-2. Approved (12 Nov):** shell rules in the gatekeeper (enforced ask rules; allow-list in log-only mode until joshua flips it). Done in #54.
- **Q-3. Approved (12 Nov):** only the model's own failures count towards the 3-failure switch-off. Done in #56.
- **Q-4. Approved (12 Nov).** A build that adds a new package can't be kept until joshua approves the new packages ("Approve new packages" in Build). Changed versions of existing packages don't block Keep. Built in #53.
- **Q-5. Approved (12 Nov), for later (Phase 3):** narrow self-maintenance. Nothing is built.

## 7. Next

The roadmap puts Phase 1 next. It adds three things:

1. **Run records:** a build ID, a record for every build including failed ones, and the cause of each failure.
2. **Findings:** one shape for check results, with trust levels.
3. **Project map:** feature to files to tests.

Phase 0 (the safety fixes in §4.1) is done in code. The two open items there (allow-list log-only, Windows untested) stay on the list.

## 8. Documentation validation report

- This update was written by reading the three docs against the code and `git log origin/main`. Each status in §3 and §4 comes from code read in this pass.
- Evidence labels are the same in all three docs.
- V1 still has eleven steps, in the plan's order. The eight-step task flow is unchanged.
- No markdown linter or link checker exists in the repo. Links between the docs and anchors were kept by hand.
- Only files under `docs/` changed. No source, config, gatekeeper or data repo file was touched. Nothing was pushed.

# Current-state audit

**Date:** 2026-11-11
**Repo:** `Player-cloud/AI-prototype-application`, branch `main` at `c2b3fcf` (merge of PR #14, step 6b). Working tree was clean before this audit. No newer commits on any branch.
**Data repo:** `Player-cloud/ai-prototype-data`, `main` at `89d0744` (merge of PR #1). Clean.
**Authority:** the Claude Doc "AI-prototype-application: full plan" (10 Nov 2026). Where anything below differs from it, the plan wins.
**Related:** [System architecture](SYSTEM_ARCHITECTURE.md) · [Product requirements](PRODUCT_REQUIREMENTS.md)

This file is read-only evidence. It says what the code does today, not what it should do. Labels used:

- **Fact:** seen in code, tests, CI or git history.
- **Inference:** a conclusion drawn from facts.
- **Unknown:** could not be checked from here.

---

## 1. What was inspected

| Area | Where |
| --- | --- |
| Tree, manifests, lockfile | `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig*.json`, `vitest.config.ts` |
| Rust shell | `apps/desktop/src-tauri/src/{lib,engine,keys,settings}.rs`, `capabilities/default.json` |
| Screens | `apps/desktop/src/**` |
| Engine | `packages/engine/src/*` (protocol, gate, budget, data, history, settings, money) |
| Models | `packages/models/src/*` (claude, openai-compatible) |
| Tools | `packages/tools/src/index.ts` |
| Memory | `packages/memory/src/*` (data-repo, spend, history, sync) |
| Checks | `packages/checks/src/index.ts` |
| Gatekeeper | `packages/gatekeeper/src/index.ts` (read only) |
| Tests | about 153 TypeScript tests in 27 files (counted by `it(`/`test(`), 16 Rust `#[test]`s |
| CI | `.github/workflows/ci.yml`; GitHub Actions runs on `main` |
| Docs | `README.md`, `CLAUDE.md`, `apps/desktop/README.md`, `templates/web-app/README.md` |
| Data repo | `ledger.md`, `habits.md`, `rules.md`, `tools/*.md`, `trials/*.md` |
| History | `git log` (PRs #1–#14), project memory notes on build status |

**Not done (and why):**
- `pnpm check` was **not run here**. `node_modules` is absent and installing packages was out of bounds for this task. Test evidence comes from CI instead.
- CI for the latest merge (`c2b3fcf`, PR #14) was **still running** at audit time. The run for PR #13's merge (`45c18bd`) passed.
- The app was not launched. Real-PC evidence comes from build notes (joshua's Windows laptop, 2026-11-10).

## 2. Where the architecture and PRD live

- **Fact:** this repo had **no** `docs/` folder, no architecture document and no PRD. The plan lives in the Claude Doc. The README has a short layout table.
- **Fact:** the old repo `Player-cloud/aPP-claude` has `docs/spec/SYSTEM_ARCHITECTURE.md` and `FUNCTIONAL_REQUIREMENTS.md` (27 Oct 2026). They describe the old Electron app. **They are superseded** by the 10 Nov plan and were not edited.
- **Decision taken:** create `docs/SYSTEM_ARCHITECTURE.md` and `docs/PRODUCT_REQUIREMENTS.md` here, using joshua's drafts as the starting point. They sit under the plan and don't compete with it. There is no older copy in this repo to merge with.

## 3. V1 progress (eleven steps)

Statuses: Not started · In progress · Implemented but unverified · Verified complete · Blocked · Unknown.

### Step 1. Tool trials (cloud): **Verified complete** (with gaps)
- **Evidence:** `ai-prototype-data/trials/round-1…4*.md`, `trials/pc-checks-2026-11-10.md`; 25 ledger lines and 10 tool cards. joshua's decisions R1–R11 are recorded in project notes. Cost about $1.93 (≈ £1.52).
- **Gaps (facts):** `ledger.md` has EGM twice: "EGM | TRIAL NEXT … not run yet" and "EGM review | ON for big builds … 10/10, $1.45". Desktop Commander, Claude in Chrome and computer use are "NOT TESTED". All trials were screening runs (1–3 runs per job).
- **Remaining:** tidy the EGM line (D-1 decided: "ON for big builds"; the data repo still needs the edit). Per D-2, step 1 also owns the baseline and the "update → stale, re-test on next use" rule. The rule is already written in `rules.md`, but no code applies it yet.

### Step 2. Repo setup: **Verified complete**
- **Evidence:** pnpm 10 monorepo (`packageManager: pnpm@10.34.9`), `CLAUDE.md`, CI matrix `ubuntu-latest` + `windows-latest` running typecheck, tests, secretlint, `pnpm audit` and `cargo test`. PR #1 merged, and later CI runs are green.

### Step 3. Window and screens: **Verified complete**
- **Evidence:** Tauri 2 shell (`lib.rs`), React rail with Projects / Build / Tools / Settings (`screens.ts`), engine helper started by `engine.rs` (JSON lines over stdin/stdout), keys in the OS password store (`keys.rs`, `keyring` crate: Windows Credential Manager, Linux Secret Service). Rust tests in CI on both systems. Confirmed on joshua's Windows laptop on 2026-11-10 (Engine badge, key saved).
- **Note:** Projects and Build are placeholders ("arrives in build step 7/8"), which is correct for now. Bundling Node into the installer is deferred.

### Step 4. Model adapter: **Implemented but unverified** for OpenAI/DeepSeek; **Verified** for Claude
- **Evidence:** `models/src/claude.ts` (Agent SDK, safe env allow-list, own `CLAUDE_CONFIG_DIR`, cost cap), `models/src/openai-compatible.ts` (one `fetch` adapter for both), `pickModel` per job. Claude **Test connection** worked on joshua's laptop.
- **Gaps (facts):**
  - The Claude adapter runs **one turn with no tools** (`tools: [], maxTurns: 1`). The agent loop with tools comes in step 8.
  - The plan says other models "likely" use the Vercel AI SDK. The code uses plain `fetch` with no extra package. That's an allowed choice ("likely"), but the shared tool loop for non-Claude models doesn't exist yet.
  - OpenAI/DeepSeek default model names are marked "unverified defaults". Real-key runs are **Unknown**.

### Step 5. Memory and data repo: **Implemented but unverified** (core parts), some parts **Not started**
- **Done (facts):** `loadDataRepo` reads ledger, habits, rules and cards. `firstRead` gives summaries first. `related()` follows `[[links]]`. Spend records go to `history.sqlite` (`SpendLog`). The budget stop is in `engine/budget.ts`. Ratings write to `ledger.md` (`setRating`). Git sync never forces and refuses key-shaped text (`syncDataRepo`). The Tools page shows real data.
- **Not yet (facts):**
  - `usingLine()` exists in `engine/src/index.ts` but nothing calls it outside tests. No task runs yet.
  - "Sync after each task" isn't wired because there are no tasks. Sync runs after a rating, after an undo, or from the Sync button.
  - Nothing writes `habits.md` ("habits it notices") yet.
  - Per D-2, step 5 also stores tool health, failure history, stale evidence and re-test results. **None of that exists yet**, so step 5 has leftover work even though its PRs are merged.
  - The data repo notes don't contain `[[links]]` yet, so graph-following isn't used in practice.
- **Verification:** sync was tested only against a **test** remote, not joshua's real data repo.

### Step 6. Gatekeeper and undo: **Implemented but unverified**
- **Done (facts):** `packages/gatekeeper` holds 6 rules (key files, push, bulk delete, deploy, outside service, global install), unchanged. `engine/gate.ts` adds a `protect-rules` guard (the agent can't edit the gatekeeper or settings) plus joshua's own rules from Settings. Settings shows the rules. The `changes` table in `history.sqlite` (`ChangeLog`, keeps 200) gives one-click Undo/Redo for settings and data-folder files, and refuses if something changed since.
- **Gaps (facts):**
  - `gate()` is reachable only through the `gate_check` method. **No agent action runs through it yet**, because there is no tool-using agent until step 8. The trial version (a PreToolUse hook) isn't wired in this repo.
  - "Undo for tools" (switching a tool on or off) has no control yet, because there's no tool on/off switch. "Undo for files" covers data-folder files only. Project files will be covered by worktrees (step 8).
  - CI for PR #14 was still running at audit time. Real-window checks used a test data repo only.

### Step 7. Plan interview: **Not started**
- **Evidence:** the Projects screen placeholder says "arrives in build step 7". There is no spec or done-file code, and `projects/` in the data repo holds only `.gitkeep`. `checks.isBigBuild()` exists (5+ features, or logins/payments/personal data) and is ready for the fresh-eyes rule.

### Step 8. Build loop: **Not started**
- **Evidence:** no worktree code (`grep worktree` finds nothing), no live step list, no fix-attempt counter.

### Step 9. Check, preview and report: **Not started** (building blocks only)
- **Evidence:** `checks.canKeep()` (blocks Keep unless every check passed and tests ran) and `FREE_CHECKS` list. No Playwright, axe or screenshot runner. No report, Keep/Undo or per-task rating screen. The existing 1–5 rating is **per tool** on the Tools page, not per task.

### Step 10. Phone messages: **Not started**
- **Evidence:** no GitHub issue, notification or work-item code.

### Step 11. First real run: **Not started**
- Depends on steps 7–10. A Linux check needs a Linux machine (open item).

**Summary:** steps 1–3 verified, step 4 verified for Claude, steps 5–6 built but only partly verified, steps 7–11 not started. **The eleven-step order can be kept as it is.** Nothing found needs a new step.

## 4. Existing systems and who owns them

"Owner" means the one place that should hold the job from now on.

| Job | Exists today? | Where | Owner from now on |
| --- | --- | --- | --- |
| Tool/capability registry | Yes, basic | `ledger.md` (status, job, evidence, cost, rating) + `tools/<name>.md` (what, use when, cost), joined by name in `memory/data-repo.ts` | **memory** (storage) with card format in **tools** |
| Model selection | Yes | `models/index.ts` `CLAUDE_MODEL_BY_JOB`, `pickModel`; called by engine | **engine** decides; **models** holds per-provider defaults |
| Tool selection, lazy loading | Partly | `tools.summaryLine`, `memory.firstRead`; Claude runs with no tools | **engine** (pick) + **tools** (runners) |
| Tool trials / evaluation | Yes, by hand | `ai-prototype-data/trials/*.md` | **memory** stores results; runs go through **checks** later |
| Agent orchestration | No | (step 8) | **engine** only |
| Memory, ledger, habits, rules, graph | Yes, read + rating write | `packages/memory` | **memory** |
| User ratings | Per tool only | `memory/sync.ts setRating` → `ledger.md` | **memory** (task rating to be added in step 9) |
| Keep/Undo decision | Rule only | `checks.canKeep` | **checks** (rule) + **engine** (flow) + **memory** (record) |
| Token and cost records | Yes | `models` report usage → `engine/budget.ts recordSpend` → `memory/spend.ts` (`spend` table) | as today |
| Budget stop | Yes | `engine/budget.ts readBudget`, `rulesWin` (30% rule) | **engine** |
| £/$ conversion | Yes, fixed rate in Settings | `engine/money.ts`, `settings.gbpPerUsd` (default 0.79) | **engine** |
| Compatibility checks | No | — | **checks** (later) |
| Dependency risk | Yes, free checks | CI `pnpm audit`, secretlint | **checks** |
| Tool conflicts / duplicates | No | — | **memory** data, **checks** test (later) |
| Security and permissions | Yes | `packages/gatekeeper` rules + `engine/gate.ts` guard + extra rules | **gatekeeper** = rule source; **engine/gate.ts** = the one place rules are applied |
| Key protection | Yes, at several points | OS keyring (`keys.rs`), env allow-list + `redact` (models), key-shape check before sync (memory), secretlint (CI) | each point stays where it is (defence in depth, not duplication) |
| Workflow execution | No | (step 8) | **engine** |
| Test execution and reports | CI only, for this repo | vitest + CI | **checks** for built projects (step 9) |
| Version tracking | No | — | **memory** (later) |
| Update watching | No | — (post-V1 in the plan) | later |
| Undo and recovery | Yes for settings/data files | `memory/history.ts ChangeLog`, `engine/history.ts` | **memory** (store) + **engine** (flow); worktrees add project-file undo in step 8 |
| Project context, specs | No | `ai-prototype-data/projects/` is empty | **memory** stores, **engine** uses (step 7) |

### 4.1 Overlaps and conflicts found

1. **Two places say which model does which job.** `models/src/index.ts` (`CLAUDE_MODEL_BY_JOB`) and `rules.md` ("Models" section) both state it. Today they agree. *Proposal:* code stays the runtime default and `rules.md` stays the human-readable copy. A future change to one must update the other. Not a V1 blocker.
2. **The job list is written twice.** `JOBS` in `engine/src/protocol.ts` and in `models/src/openai-compatible.ts` (the `Job` type itself lives in models). Small code tidy-up for a later PR; this task changes no code.
3. **Provider display names are written twice** (`engine/protocol.ts` and `engine/history.ts`). Cosmetic.
4. **The registry has two halves joined by a fuzzy name match.** Ledger lines and tool cards are matched by "one name contains the other" (`sameTool`). It works for the 25 tools today but has no stable ID. Any future capability evidence should key on a stable name (the card file name) rather than add a new registry.
5. **The gatekeeper is split across two places** *(resolved by D-3: the guard moves into the gatekeeper)*. Rule *content* is in `packages/gatekeeper`. The *protect-rules guard* and joshua's own rules are applied in `engine/gate.ts`. The engine still uses the gatekeeper's rules unchanged. *Open decision:* whether the protect-rules guard should one day move into `packages/gatekeeper`. Only joshua can make that change.
6. **The gatekeeper isn't yet in the path of any agent action.** No agent uses tools yet. Step 8 must route every tool call through `gate()` (e.g. as the Agent SDK `canUseTool`/PreToolUse hook). This is already step 6/8 scope, not a new requirement.
7. **The EGM ledger line contradicts itself** (see step 1). *Resolved by D-1.*
8. **Some plan principles have no named build step:** "3 failures in a row → switch off", "tool update → results stale, re-test", and "app writes habits it notices". They're core principles in the plan but none of the eleven steps names them. *Resolved by D-2*: split across steps 1, 5, 8 and 9 (see §6).
9. **The £/$ rate is fixed.** The plan says "with the day's conversion rate". The code uses a rate set in Settings (default 0.79) because live rate lookups would be a new outside service. Reports should show the rate used. This is a known gap, not a new system.
10. **The old Electron spec docs** (`aPP-claude/docs/spec/*`) are superseded. They're left as they are and will be archived with that repo.

No duplicate engine, database, test runner or approval authority was found. `history.sqlite` is the one local database (tables `spend` and `changes`).

## 5. What this means for step 7 and later

- **Step 7 scope and order are unchanged.** The doc updates add nothing to step 7.
- Step 7 should store the spec and done files under `ai-prototype-data/projects/<name>/`, using the existing memory and sync code rather than a new store.
- Step 8 is where three existing pieces get wired in: `gate()` on every agent tool call, `usingLine()` at the start of each run, and sync after each task.
- Step 9 needs a per-task record that links spend rows to a run (model, tools, tests, Keep/Undo, rating). The plan's learning order needs it. It belongs as a table in the existing `history.sqlite`, owned by memory, not as a new database.

## 6. Decisions for joshua

- **D-1. Decided (joshua, 2026-11-11):** EGM is "ON for big builds". Still to do: edit `ledger.md` in the data repo so the "EGM | TRIAL NEXT" line no longer contradicts it. Not done here, because this task changes no data files.
- **D-2. Decided (joshua, 2026-11-11):** spread over steps 1, 5, 8 and 9, no 12th step.

| Step | Its part |
| --- | --- |
| 1 Tool trials | The first test and reliability baseline for each tool. When a tool updates, its earlier results are marked stale and a re-test is due on next use. |
| 5 Memory and data repo | Saves tool health, failure history, stale evidence, re-test results and habits; updates tool cards and the data repo records. |
| 8 Build loop | Enforces "3 failures in a row": switch the tool off, tell joshua, and never pick it again until he chooses retry, re-enable or uninstall. Switching off never uninstalls. |
| 9 Check, preview and report | After Keep/Undo and the rating, learns: spots repeated preferences, updates `habits.md` once there's enough evidence, and tells joshua. |

Owners: **engine** enforces failure handling and skips switched-off tools; **tools** runs tools and notices health and version or config changes; **memory** owns tool records, stale evidence, habits and learning history. `rules.md` stays above `habits.md`, except below 30% of the monthly budget (P-03). No new system, registry or service.

  Because steps 1 and 5 are already merged, their new parts need follow-up PRs. The build thread plans these as one small follow-up PR before step 8.
- **D-3. Decided (joshua, 2026-11-11):** move the protect-rules guard into `packages/gatekeeper`. The gatekeeper becomes the single authority for protected changes and approval rules. The agent can't change or get around them, and rule changes only happen with joshua's approval through Settings. This is a **code change in joshua's package**. His message is the approval for it. It goes in its own PR, separate from these docs, and is handled by the build thread. **Scope (joshua, Option A):** the guard keeps protecting the gatekeeper package and `settings.json`. The app may still update `rules.md` itself and tell him afterwards, as the plan says. Every `rules.md` change is recorded in the change history and can be undone. The existing `changes` table already handles data-folder files, but nothing writes `rules.md` yet.
- **D-4. Decided (joshua, 2026-11-11):** keep these docs uncommitted while he reviews them. No PR until he approves. The docs PR stays separate from any code change.

## 7. Documentation validation report

Checked by reading the documents against the plan and the code, and by a one-off script (not added to the repo) that checks links, section anchors, requirement IDs and the step list.

- Links and anchors between the three docs: **0 broken**.
- Requirement headings in the PRD: **22 IDs, no duplicates** (V1-01…11, CAP-V1-01…05, CAP-01…06). Table IDs: P-01…13, EVAL-01…07, SUP-A…I, NFR-01…07, SEC-01…07, EVD-01…06, UI-01…03.
- Step names in the PRD (§4) and architecture (§11) match the plan word for word, in the same order.

- V1 has exactly eleven steps, same order and wording as the plan: **yes** (PRD §4, architecture §11).
- The eight-step task flow is unchanged: **yes** (architecture §7).
- Plan interview stages unchanged (7 stages, all questions per stage in one message): **yes**.
- Fresh-eyes/paid reviews only on big builds (5+ features, logins, payments, personal data): **yes**.
- £20 budget, may rise to £40, 30% rule, 2 fix attempts, 3-failures rule, one feature per worktree, tests never cut, Keep/Undo, 1–5 rating: **all kept**.
- No second engine, gatekeeper, registry, memory or database is introduced: **yes**. Every new responsibility names an existing package as owner.
- Every post-V1 system is labelled `Post-V1` or `Proposed`: **yes**.
- Nothing unverified is described as done: statuses come from §3 of this audit.
- The architecture and PRD give the same owner for each job: checked by reading (architecture §12–14, PRD §5–7).
- No markdown linter or link checker exists in the repo, so none was run and none was installed. `pnpm check` was not run (see §1). These are Markdown-only changes, so they don't affect typecheck or tests. The secret scan covers `**/*` and will scan them in CI.
- Git diff: only the new `docs/` folder (3 files). No source, config, gatekeeper, data repo or user files changed. Nothing committed or pushed.

# AI-prototype-application: system architecture

**Status:** working architecture, 2026-11-12. Checked against the code at `99ac216` (merge of PR #56). The previous version described `c2b3fcf` (11 Nov, step 6b).
**Authority:** the Claude Doc "AI-prototype-application: full plan" (10 Nov 2026). If this file disagrees with it, the plan wins and this file is wrong.
**Related:** [Product requirements](PRODUCT_REQUIREMENTS.md) · [Current-state audit](CURRENT_STATE_AUDIT.md)

Every part below carries one of these evidence labels (the same in all three docs):

| Label | Meaning |
| --- | --- |
| **Verified** | Code + tests + real-use evidence |
| **Implemented** | Code + unit tests, no real-use proof yet |
| **Partial** | Some of it is built; the rest is not |
| **Missing** | Not in the code |
| **Planned** | In the roadmap, not started |

Real-use evidence that exists (given, from the private data repo): the first real build, Club HR F-01, passed on 12 Nov (£0.09 / $0.11); the free tests (CI-3) for secretlint, axe-core, playwright and checklist-rules passed on one computer; the environment check (CI-2) ran on one computer; update look-up (CI-6) ran and 9 updates were OK'd. The phone flows, the live view, CI-4, CI-5, CI-7 and CI-8 have no real-use record yet. A merged PR is never enough for **Verified**.

Nothing labelled Planned is required for V1.

---

## 1. Purpose and principles

A desktop app for one person (joshua) on Windows and Linux. You describe a web app; it plans it with you stage by stage, builds one feature at a time, checks it, previews it, and you press Keep or Undo and give a 1–5 rating.

The app has two jobs, in this order:

1. **Build projects.** Plan → build → check → preview → Keep/Undo. This is V1.
2. **Get better at choosing.** Learn which models, tools and ways of working do best, from real evidence ("Capability Intelligence", §12). V1 records the evidence; the Capability Centre screen now shows it.

Principles (from the plan, plus rules this doc relies on):

1. **Keep V1 as planned.** Nothing here adds, moves or grows a V1 step.
2. **One owner per job.** No second registry, memory, database, engine, test runner, cost calculator or approval authority.
3. **Tokens, then quality, then price.** Quality first for planning, final review and security. Price matters most once spend would pass £20.
4. **Tools off until picked.** One tool per job. Token savers may stay on.
5. **Evidence over opinion.** Test results, the user's rating and model opinions are stored apart.
6. **Advice is not permission.** Capability Intelligence may suggest. The engine decides. The gatekeeper approves risky steps.
7. **Honest status.** Passed, failed, skipped, blocked, not run, stale and unknown are all different.
8. **Evidence belongs to a version.** A result applies to the tool or model version it was measured on.
9. **joshua stays in control.** Changes to habits or rules are reported; undo and history are always kept.

## 2. Current architecture

```
          ┌──────────────────────────── desktop app ────────────────────────────┐
 joshua → │ React screens ──Tauri commands──▶ Rust shell ──JSON lines──▶ Engine │
          │                                   (keys in OS store)    (Node helper)│
          └──────────────────────────────────────────────────────────────┬──────┘
                    Engine uses: models · tools · memory · checks · gatekeeper
                    Stores: history.sqlite (this PC) · ai-prototype-data (GitHub) · project repos
                    Phone: GitHub Issues on the data repo (token in the OS store)
```

| Part | Label | What exists |
| --- | --- | --- |
| Tauri shell + React screens | **Verified** | Rail: Projects, Build, Tools, Capability Centre, Settings. Needs you and History panels. All screens are real now; the old placeholders are gone. |
| Engine helper | **Verified** | Node process started by Rust; one JSON object per line on stdin/stdout, plus event lines while a build runs. The methods are listed in the header of `packages/engine/src/protocol.ts`. |
| Keys and GitHub token | **Verified** | OS password store (Windows Credential Manager, Linux Secret Service). Never written to a file or sent back to the screens. |
| Claude adapter | **Verified** | Agent SDK. Plain ask (one turn, no tools) and **build** (tools, in the feature's own copy). |
| OpenAI / DeepSeek adapter | **Implemented** | One `fetch` adapter; one turn, no tools. **Building needs Claude.** No real-key run recorded. |
| Plan interview, review | **Implemented** (the spec path is **Verified** by F-01) | Seven stages, Claude's suggestions, plan and fresh-eyes review. |
| Build loop | **Verified** (one real build) | Worktree per feature, checked steps, tests, 2 fix attempts. |
| Keep, Undo, rating, learning | **Implemented** | Merge into joshua's own copy (never a push). |
| Phone (GitHub Issues) | **Implemented** | Work items, Keep/Undo/rating, start a build, questions. No real-use record. |
| Live view | **Implemented** | The build's page on 127.0.0.1 while the model works. No real-use record. |
| Memory: data repo, ratings, sync, health records | **Implemented** | See §8. |
| Spend + budget stop | **Verified** | `spend` table; calls refused when the month's budget is used up; per-run limit (£0.80 default). |
| Gatekeeper, guard, own rules, shell rules | **Implemented** | In the path of every build tool call. See §10 and §16. |
| Undo history | **Implemented** | `changes` table; undo/redo for settings, data-folder files and project tool choices; CI-8 checks it worked. |
| Checks | **Verified** (tests, free checks, pictures in the real build) | Runners now exist. See §9. |
| Capability Centre | **Implemented** | Real records only. See §12.6. |
| CI | **Partial** | Workflows exist but no job has started since 11 Nov 19:12 UTC. See §9. |

Details and evidence: [audit §3](CURRENT_STATE_AUDIT.md#3-v1-progress-eleven-steps).

## 3. Tauri and React interface

- **Screens** (`apps/desktop/src`) only ask the engine, through Rust commands. They never call a model, tool, package manager or outside service. **Verified.**
- **Rust shell** (`apps/desktop/src-tauri`) stays small: it opens the window, starts the engine, holds keys and the GitHub token, and reads/writes `settings.json`. 22 Rust tests (counted by `#[test]`).
- **Settings file** `settings.json` (app config folder, no keys): provider, budget, £/$ rate, run limit, model choices, prices, data folder, joshua's extra rules. The agent can never edit it (guard in `packages/gatekeeper`). **Implemented.**
- **Screens built:** Projects (plan interview, spec, code folder), Build (Using line, live steps, live view, report, pictures, Keep/Undo, rating, Stop), Tools, Capability Centre, Settings (budget and models, safety rules, GitHub token), History, and the Needs you panel (waiting builds, new packages to approve, ask-first requests with Allow once / No). **Implemented**; the real build used the Projects and Build path.

## 4. TypeScript/Node engine

`packages/engine`, the only orchestrator.

- **Verified (one real build):** request handling (`protocol.ts`), budget policy (`budget.ts`: refuse when used up, per-call and per-run caps, 30% rule), the build loop (`build.ts`), the `Using:` line (`using.ts`), money in £ and $ (`money.ts`), project and interview flow (`interview.ts`, `projects.ts`).
- **Implemented:** the gate (`gate.ts`), Keep/Undo/rating (`keep.ts`), habit learning (`learn.ts`), asks (`asks.ts`), phone messages (`github.ts`, `notify.ts`, `replies.ts`, `phone.ts`, `questions.ts`), honest report (`claims.ts`), workflow advice (`workflows.ts`), evaluations and experiments (`evals.ts`, `experiments.ts`), updates (`updates.ts`), project tools (`project-tools.ts`), the Capability Centre (`centre.ts`), undo flow (`history.ts`).
- **3-failures rule (D-2, Q-3), Implemented:** each model run goes in the model's health record. Three failures in a row switch the model off, joshua is told, and it isn't picked until he switches it back on. **Only the model's own failures count** (Q-3): a cost limit, network drop, busy provider, bad key or no credit, or a Stop does not. Switching off never uninstalls.
- The engine makes **every** runtime choice of model and tools. Other parts give it facts and advice only.

## 5. Model adapters

`packages/models`. Every adapter has the same shape: `run({job, prompt, model}) → {text, usage}` with tokens and cost (cost `null` when the price isn't known). The Claude adapter also has `build`.

- Claude through the Agent SDK. **Verified.** The build uses an allow-listed environment, a throwaway home folder (§16), a hook and `canUseTool` that both call the engine's check, and a cost cap.
- OpenAI and DeepSeek through one OpenAI-compatible adapter (plain `fetch`, no extra package). **Implemented.** No tool loop, so no building.
- Failure causes (`causes.ts`, Q-3): model, budget, network, provider, setup, stopped, unknown. Only "model" counts towards switching a model off.
- Model per job: Opus plans and does final and security review; Sonnet builds and reviews plans; Haiku reads, summarises, writes tests and reviews code (Sonnet for security or multi-file changes). The table is in `CLAUDE_MODEL_BY_JOB` and copied in `rules.md`. They must stay in step ([audit §5.1](CURRENT_STATE_AUDIT.md#51-overlaps-and-conflicts-found) item 1).
- Models report usage. They don't decide budgets and they don't orchestrate.

## 6. Lazy tool execution

`packages/tools` and the runners in `packages/checks`.

- **Implemented:** the tool card format (`parseCard`) and the one-line summary the engine reads.
- **Verified (real build):** the free-check runners start only when the build reaches them: secretlint, `pnpm audit`, checklist rules, Playwright pictures with the browser already on the PC, axe, phone width.
- **Implemented (CI-1):** each check tool's version is noticed. A new version marks its old evidence stale; a good run clears the mark. Tool IDs are the card file names.
- **Implemented (CI-7):** joshua can approve a set of tools for a project. Builds for that project then use only those build models. Free safety checks always run whatever the list says.
- Adding a tool means adding a card. Tools that cost money or send code or data to a new outside service need joshua's OK first (gatekeeper).
- **Not allowed (any release):** installing, enabling or removing a tool just because it scored well.

## 7. Task flow (unchanged from the plan)

1. You ask in plain words (on the PC, or from your phone: "build club hr F-02").
2. The engine reads short summaries of the ledger, habits and rules, and opens a full file only if unsure.
3. It picks the model and tools and shows `Using: …` first.
4. It builds in a git worktree, one feature per run, with a live step list (and a live view of the page).
5. It checks: tests (must pass), free checks (secrets, audit, new packages, checklist rules). If tests fail: 2 automatic fix attempts, then stop and tell you.
6. It previews: desktop and phone pictures every build, with axe and phone width.
7. It reports what changed, tests, cost in £ and $, pictures, and what the model's summary claimed beside what the app found. You press Keep or Undo and give a 1–5 rating.
8. It learns and syncs: the app's own habits section updates and the data repo syncs to GitHub.

Capability Intelligence only feeds better facts into step 3 and better records into step 8. It adds no step.

## 8. Memory and private data repo

`packages/memory` owns all saved knowledge and history.

**Private data repo** `ai-prototype-data` (Markdown and small JSON files, synced to GitHub):

```
ledger.md        one line per tool: name | status | job | evidence | cost | rating
habits.md        joshua's habits; the app adds ones it notices (its own section) and says so
rules.md         general tool rules (the app does not write it yet)
tools/<name>.md  one card per tool
tool-health/     one file per tool: versions, failures, stale marks, switched off
evaluations/     free test results per capability (CI-3)
experiments/     proposals from repeated runs (CI-5)
environments/    one file per computer (CI-2)
updates.json     updates found and joshua's decisions (CI-6)
trials/          tool trial results
projects/<name>/ spec.md, done/, review.md, answers.md, tools, rules.md
```

**Local database** `history.sqlite` (this PC only, Node's built-in SQLite, no extra package):

| Table | Label | Holds |
| --- | --- | --- |
| `spend` | **Verified** | every model call: time, provider, model, job, tokens, $ cost |
| `changes` | **Implemented** | every settings or data-file change with exact before/after, for undo (keeps 200) |
| `runs` | **Implemented** | one row per feature build, made at the start (its id is the build ID, shared with spend rows): model, cost, tests, fix attempts, checks, pictures, Keep/Undo, rating; status running → built / failed (cause, error) / stopped / interrupted (#57). |
| `work_items` | **Implemented** | things that need joshua, with their GitHub issue |
| `asks`, `ask_approvals` | **Implemented** | ask-first requests and single-use "Allow once" approvals (24 hours) |

The `runs` table is the task-run record the plan's learning order needs. Phase 1 widens it (see §20).

Rules: keys never go in either store; sync refuses key-shaped text; sync never forces. Sync pulls with rebase and then pushes (an "approved engine action", §16).

**Habits and rules (D-3, Option A):** the app writes only its own section of `habits.md`, after Keep, Undo or a rating, and only with enough evidence. Each write is in History with Undo, and joshua is told. `rules.md` stays above `habits.md` except below 30% of the budget. The app does not write `rules.md` yet, and it is not guarded.

## 9. Checks and testing

`packages/checks` owns "did it work?".

- **Verified (first real build):** `runTests` (installs with `--ignore-scripts`, then the project's tests), the free checks, pictures, `canKeep` (no Keep unless tests ran and every non-advice check passed).
- **Implemented:** the "New packages" check (a package the build added to any `package.json` stops Keep until joshua approves), `isBigBuild` (5+ features, or logins, payments or personal data), the live preview, the environment check (CI-2, **Verified** on one computer), repeatable free tests per tool (CI-3, **Verified** on one computer), update look-up (CI-6, **Verified**).
- **Planned:** one shape for all check results, with trust levels (Phase 1 "Findings"). Paid and fresh-eyes reviews on big builds exist for plans (step 7c); code reviews by a model are not built.
- **CI for this repo (Partial):** two workflows. `ci.yml` runs typecheck, tests, secretlint and `pnpm audit` on `ubuntu-24.04` and `windows-latest`, with a 20-minute limit. `shell.yml` runs the Rust `cargo test` on both only when `apps/desktop/src-tauri` changes. **No GitHub Actions job has started since 11 Nov 19:12 UTC** (account billing). Branch protection isn't available on the private free plan, so checks can't be required. Until Actions runs again the only gate is the local `pnpm check`.
- **Tests today:** 605 TypeScript tests in 68 files, plus 22 Rust tests (counted, not run here). Run `pnpm typecheck` before `pnpm test` on a fresh checkout so the packages' output exists.

## 10. Gatekeeper

`packages/gatekeeper` is joshua's. Agents never edit it.

- **Implemented:** `protectRules` (the guard that stops the agent changing this package or `settings.json`) lives here and **always runs first**, whatever rules are passed in (D-3). Then six ask-first or never rules (key files: never; push, bulk delete, deploy, outside service, global install: ask). Then 14 shell rules (Q-2, #54): hidden key-file names (never), and ask rules for commands hidden in commands, pipes into a shell, eval, environment changes, sudo, risky git, code typed on the command line, package runners, installs that run scripts, recursive or forced deletes, links, network tools and the home folder.
- **Partial:** a shell allow-list of known build programs. It is in **log-only mode** (`SHELL_ALLOW_LIST_ENFORCED = false`): an unknown program is allowed with a note in the step list. joshua flips it after 3 real builds.
- `engine/gate.ts` only adds joshua's own ask-first rules from Settings. It no longer holds a guard.
- **Ask rules really ask (#55):** an ask-first refusal in a build goes to Needs you with the exact command. "Allow once" lets that exact tool and input through one time in that project, within 24 hours; "No" closes it. Both are recorded in History. Never-rules, the guard and the own-copy checks can't be overridden.
- The gatekeeper is the **only** approval authority. Findings, scores and recommendations can make the app *ask*; they can never *approve*.
- `rules.md` is **not** guarded (D-3, Option A). The app may update it and tell joshua, with history and Undo. It doesn't write it yet.

## 11. Git worktree isolation and the V1 build order

- Each build runs in its own git worktree of the project repo, one feature per run. **Verified** (F-01). Undo = drop the worktree and branch. Keep = merge it into joshua's own copy (never a push); it's refused when his copy has uncommitted changes.
- Each website gets its own GitHub repo. The app can make a new empty code folder for a project.

**V1 build order (unchanged, one PR each):**

1. Tool trials (cloud)
2. Repo setup
3. Window and screens
4. Model adapter
5. Memory and data repo
6. Gatekeeper and undo
7. Plan interview
8. Build loop
9. Check, preview and report
10. Phone messages
11. First real run

There is no twelfth step. Steps 7 to 11 are now built (PRs #16 to #35); step 11 is **Partial** (one real feature passed; Linux check and the full eight-step evidence are open). V2 A to D, CI-1 to CI-8 and the Capability Centre came after, as separate PRs (#36 to #48).

## 12. Capability Intelligence

### 12.1 What it is

The app's evidence-based knowledge of what it can use: models, tools, plugins, skills, mods and extensions, agents, and workflows. It answers: what is this, which version, what evidence says it works for this job, what does it cost, what does it need, is it safe and allowed, and is the evidence still current?

It is **advice and records**, never a second engine, registry, memory, test runner or gatekeeper. It has **no package of its own**. Its jobs are spread over existing owners:

| Job | Owner |
| --- | --- |
| Where capability facts and evidence are stored | memory (ledger, cards, health, evaluations, `history.sqlite`) |
| Card format and runners | tools, checks |
| Usage and cost numbers | models |
| Running evaluations | checks |
| Ranking candidates and choosing | engine |
| Allowing risky use | gatekeeper |

### 12.2 What exists now

| Foundation | Where | Label |
| --- | --- | --- |
| Trial results per tool | `trials/`, ledger evidence column | **Verified** |
| One-line summaries, cards, stable IDs (card file name) | `tools/*.md`, `firstRead` (CI-1) | **Implemented** |
| Versions and stale marks | `tool-health/` (CI-1, D-2) | **Implemented** |
| Compatibility per computer | `environments/` (CI-2) | **Verified** (one computer) |
| Repeatable free tests | `evaluations/` (CI-3) | **Verified** (one computer) |
| Workflow comparisons feeding the engine's advice | `engine/workflows.ts` (CI-4) | **Implemented** |
| Experiments and regression checks | `experiments/` (CI-5) | **Implemented** |
| Update look-up, adopted only with joshua's OK | `updates.json` (CI-6) | **Verified** |
| Tools per project, reading docs for old or clashing instructions | `projects/<slug>/` (CI-7) | **Implemented** |
| Going back from updates and settings, checked | CI-8 | **Implemented** |
| Capability Centre | `engine/centre.ts`, Centre screen | **Implemented** |
| Tool rating 1–5 | ledger rating column | **Implemented** |
| Token and cost per call | `spend` table | **Verified** |
| What was actually used | `Using:` line | **Verified** (shown in the real build) |
| Tests, Keep/Undo, build rating | `runs` table | **Implemented** (finished builds only) |
| Confidence and freshness on every result | | **Missing** (CAP-04) |

### 12.3 Capability kinds and what to measure (Planned)

| Kind | Examples of what matters |
| --- | --- |
| Models | task success, code quality, following instructions, tool use, cost, speed |
| Tools | does its job, reliability, error handling, speed, output correct |
| Plugins | permissions, data handling, reliability, dependencies, can be removed cleanly |
| Skills | triggers at the right time, clear, consistent, token overhead, conflicts |
| Mods / extensions | source integrity, compatibility, stability, permissions, reversible |
| Agents | stays in scope, tool-use accuracy, cost per task, hand-off quality |
| Workflows | end-to-end success, defects, total cost, time, how often joshua had to step in |

Only free-check tools (secretlint, axe-core, playwright, checklist-rules) have repeatable tests today. Model, plugin, skill, mod and agent suites are **Planned**.

### 12.4 Evaluation

Discovery → registration (a card) → source and version check → reading the docs and source → functional, speed and reliability tests → security, compatibility and dependency checks → cost measurement → evidence saved → comparison with history → recommendation.

- Every result names the capability **version** and the **computer**.
- Tests run through `packages/checks`, on test data. Nothing private is sent to a new service without joshua's OK. A blocked test (no browser, say) records nothing against the tool.
- A 1–3 run trial is a screening result, not a benchmark, and is shown that way.

### 12.5 Scoring

Six measures, kept apart:

| Measure | Question |
| --- | --- |
| Capability quality | How well does it do its job? |
| Task suitability | How well does it fit this task? |
| Trust and security | Is it safe and allowed? (pass / restricted / blocked / not checked) |
| Cost efficiency | Tokens, money, time |
| User satisfaction | joshua's 1–5 ratings |
| Evidence confidence | How many runs, how recent, how complete |

- The Capability Centre does not add anything into one grade. An optional 0–100 score is still **Planned**, with weights per kind that joshua can see.
- **A security or policy failure can't be outweighed by a high score.** Blocked is blocked.
- **Untested stays "untested"**, never 0.
- The user's rating is never mixed into the automatic results.

### 12.6 Screens

The **Capability Centre** is built (**Implemented**, no real-use record). It shows every tool and model: where it is in its life (in use, stale, on trial, not tested, switched off, retired), free test results, real-build evidence, computers, health and joshua's rating, with comparisons and recommendations. Every number comes from a real record; "Not tested" and "No builds yet" are shown where there is none. It changes nothing.

## 13. Supporting intelligence systems

These are **jobs, not packages**. Each has one owner.

| System | Does | Owner | Label |
| --- | --- | --- | --- |
| A. Environment and compatibility | runtime, package, tool and version fit; conflicts; duplicates | checks + memory | **Verified** for the environment check (one computer); duplicates listed; conflict tests **Missing** |
| B. Security and trust | review of source, dependencies, permissions, network and file access | checks (finds) → gatekeeper (decides) | **Partial**: secretlint, audit, new-packages check and gatekeeper exist; no wider review |
| C. Workflow | which models and steps work best per job type | engine (uses) + memory (stores) | **Implemented** (CI-4 advice only) |
| D. Experiment and learning | repeatable tests, before/after, regressions, learning from real tasks | checks (runs) + memory (stores) | **Implemented** (CI-5, step 9d) |
| E. Capability lifecycle | discovered → inspected → evaluated → approved → in use → stale → retired | memory | **Implemented** in the Centre; states come from records |
| F. Resources | tokens, $ and £, time, cost per successful task | models + engine + memory | **Implemented**: spend table, budget stop, 30% rule, cost per build |
| G. Knowledge and docs | read docs, spot old or conflicting instructions | memory | **Implemented** (CI-7 doc check, flags only) |
| H. Project | each project's spec, stack, limits, approved tools | memory + engine | **Verified** for spec (F-01); tools per project **Implemented** |
| I. Recovery and change | rollback, config recovery, post-change checks | memory (`changes`) + engine (worktrees) | **Implemented** (CI-8) |

Rules that keep these from becoming duplicates:

- B never approves anything. It reports; the gatekeeper decides.
- C never runs tasks. It advises; the engine runs them.
- E extends the ledger and cards. It's not a second inventory.
- F extends `spend` and `budget.ts`. £20 budget, possible £40, 30% rule unchanged.
- G and H use the existing memory. Project facts stay apart from joshua's global habits.
- I extends `changes` and worktrees. Nothing is assumed rolled back without checking.

## 14. Who owns what

| Owner | Owns | Must never become |
| --- | --- | --- |
| `apps/desktop` | screens, Rust shell, keys, settings file | a model or tool runner, or a rule authority |
| `packages/engine` | task flow, model/tool choice, worktrees, retries, budget policy, applying the gate, `Using:` line, 3-failures rule, Keep/Undo flow, phone messages | an evaluator, a store, a rule editor |
| `packages/models` | provider adapters, usage and cost reports, failure causes, per-provider defaults | an orchestrator |
| `packages/tools` | card format | an installer, a second registry |
| `packages/memory` | data repo, ledger, habits, cards, `history.sqlite`, sync, evidence records, tool health, learning | a second database, or a writer of joshua's preferences without telling him |
| `packages/checks` | tests, free checks, pictures, live preview, Keep rule, big-build rule, environment check, repeatable tests, update look-up | a workflow engine or approver |
| `packages/gatekeeper` | the guard, ask-first and never rules, shell rules (joshua only) | something the agent or a score can change |
| `templates/web-app` | standard stack starter | a registry |

## 15. Data flow and boundaries

```
request (PC or phone) → engine
        → reads summaries (memory) + capability evidence (memory)
        → picks model and tools, shows Using line (engine)
        → each tool call: inside the copy? (words, real paths) → gatekeeper
              ask-first? → Needs you → joshua: Allow once / No
        → build in worktree (engine, models)
        → tests → free checks → pictures → report (checks)
        → Keep/Undo + rating (joshua, PC or phone)
        → records + habits + sync (memory)
```

Dependency direction (no cycles): desktop → engine → {models, tools, memory, checks, gatekeeper}; memory → tools (card parsing). Gatekeeper depends on nothing.

| Item | Rule |
| --- | --- |
| Inputs to choosing | summaries, evidence, budget state, project spec |
| Outputs | `Using:` line, run record, ledger/cards updates |
| Evidence source | every record names where it came from (trial file, run, evaluation) and its date |
| Versioning | records carry the tool or model version where known; "unknown" otherwise |
| Failure | a tool that fails is reported as failed, never as passed; completed work is kept |

## 16. Security and trust boundaries

**Keys:** OS password store only. Passed to the engine for one call. Never in chat, Markdown, GitHub, logs, prompts or pictures. Sync refuses key-shaped text. All **Verified** for keys.

**Layers around the build agent (all Implemented, none has a real-use record of refusing something):**

1. **Sandbox environment (#50):** the agent runs with only listed environment variables, its own empty home folder, no git login and no way to `git push` (set with `GIT_CONFIG_*` values that beat the repo's own config). Local commits still work. The folder is removed at the end of the build.
2. **Hook plus `canUseTool` (#51):** a PreToolUse hook (blocks if its check fails) and `canUseTool` both call the engine's one check.
3. **Word check and real-path check (#51):** every path the tool names must be inside the feature's own copy; file paths are also turned into their real place (links followed) and must still be inside. Shell commands get the word check only.
4. **Gatekeeper rules and shell rules (#54):** the guard first, then the six rules, joshua's own rules, and the 14 shell rules (§10).
5. **Ask → Needs you (#55):** ask-first steps are refused, shown to joshua with the exact command, and run only after "Allow once" (single use, 24 hours).
6. **Installs without scripts, and new packages need an OK (#52, #53):** installs for tests use `--ignore-scripts`. A package a build adds stops Keep until joshua approves it ("Approve new packages").
7. **Q-3 (#56):** only the model's own failures count towards switching it off.

**Approved engine actions.** The engine does these itself, outside the Gatekeeper, by design:

1. Data-repo commit and push after tasks (F3). Never forced; key-shaped text refused.
2. GitHub issues for phone messages (fine-grained token, Issues on the data repo only).
3. `pnpm outdated` look-ups (CI-6). Only package names go to the registry. Nothing is installed.
4. Package installs with `--ignore-scripts` for tests.
5. The live dev server and the picture server, on 127.0.0.1 only.

**Still open:**

- The shell allow-list only logs (`SHELL_ALLOW_LIST_ENFORCED = false`) until joshua flips it.
- Windows is untested for the sandbox environment and for links and junctions.
- The real-path check doesn't cover shell commands.
- Imported tools, plugins, skills and packages are untrusted until checked. Evaluating them isolated is **Planned**.
- The app may change itself only when the change is small, all tests pass, and it doesn't touch security, keys, payments, deploys or approval rules. **Q-5 (approved 12 Nov, Phase 3):** narrow self-maintenance. Nothing is built.
- Nothing installs, enables, disables or removes a capability because of a score.

## 17. Compatibility and lifecycle

- **V1:** CI on Ubuntu and Windows is written but **not running** (billing, §9). Template rules (pnpm 10 pinned, shadcn via npx). Lifecycle = the ledger status column plus tool health (switched off, stale).
- **Implemented (D-2):** tool update → old results stale → re-test on next use (CI-1); 3 failures in a row → tell joshua and switch off (Q-3 narrows what counts); uninstalling is decided together.

**Tool lifecycle split (D-2):**

| Step | Its part | Label |
| --- | --- | --- |
| 1 Tool trials | Baseline for each tool. When a tool updates, earlier results are stale and a re-test is due on next use. | **Implemented** in code (CI-1) |
| 5 Memory and data repo | Saves tool health, failure history, stale evidence, re-test results and habits. | **Implemented** |
| 8 Build loop | "3 failures in a row": switch off, tell joshua, never pick until he chooses. Switching off never uninstalls. | **Implemented** |
| 9 Check, preview and report | After Keep/Undo and the rating, learns repeated preferences into `habits.md` and tells joshua. | **Implemented** |

Owners: **engine** enforces failure handling and skips switched-off tools; **checks and tools** notice versions; **memory** owns the records.

- **Implemented:** version fields in health records, compatibility per computer (CI-2), update detection kept apart from installing (CI-6; the app never installs). **Missing:** retirement suggestions; a check that two computers' versions agree beyond showing the difference.

## 18. Evaluation and scoring concepts

See §12.4–12.5. Capability, version, evaluation run, evidence item, usage and relationship records exist today as the health, evaluation, experiment and environment files in the data repo, not as `history.sqlite` tables. Two are still **Missing**: a selection-decision record ("why this was picked") and per-result confidence.

## 19. Failure and recovery

- Tests fail → 2 fix attempts → stop and report. **Implemented.**
- Budget used up → calls refused with a plain message. **Verified.**
- Run limit reached → the run stops; no fix attempt below a small floor. **Implemented.**
- Sync clash → stop, keep the local change, say so; never force. **Implemented.**
- Undo when something changed since → refuse and touch nothing; CI-8 checks the file or setting is back. **Implemented.**
- Model fails 3 times in a row for its own fault → off, tell joshua. **Implemented.**
- A failed build is not saved as a run record yet. **Missing** (Phase 1).
- Evaluation tool unavailable → "blocked" or "not run", never "passed". **Implemented.**
- Project-file undo → drop the worktree. **Verified.**

## 20. Next

The roadmap puts **Phase 1** next. It adds:

1. **Run records:** a build ID, every build including failed ones, and the cause of each failure.
2. **Findings:** one shape for check results, with trust levels.
3. **Project map:** feature → files → tests.

Then, as the plan sets out: Phase 3 includes **Q-5**, narrow self-maintenance. After V1, the plan's list stays: deploy and client handover, self-improvement, update watching, tool clean-up, more phone actions. A new package or screen is added only with evidence that an existing owner can't hold the job, and with joshua's OK.

### Change rules for this document

A change must state: the code evidence, the existing owner considered first, why it isn't enough, data and migration impact, gatekeeper and cost impact, Windows and Linux impact, tests and rollback, and whether it touches the V1 order. Anything that changes the V1 order, adds an approval authority, duplicates a store, or weakens a safety rule needs joshua's explicit OK.

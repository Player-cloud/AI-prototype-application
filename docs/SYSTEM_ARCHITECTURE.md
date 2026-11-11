# AI-prototype-application: system architecture

**Status:** working architecture, 2026-11-11. Built from joshua's draft and checked against the code at `c2b3fcf`.
**Authority:** the Claude Doc "AI-prototype-application: full plan" (10 Nov 2026). If this file disagrees with it, the plan wins and this file is wrong.
**Related:** [Product requirements](PRODUCT_REQUIREMENTS.md) · [Current-state audit](CURRENT_STATE_AUDIT.md)

Every part below carries one of these labels:

| Label | Meaning |
| --- | --- |
| **Built** | In the code on `main` and checked (tests, CI, or a real run) |
| **Partly built** | Some of it is in the code; the rest is still to come |
| **V1 planned** | Part of the eleven V1 steps, not built yet |
| **Post-V1** | In the plan's "after Version 1" list, or needed by it |
| **Proposed** | New in this document; not approved by joshua yet |

Nothing labelled Post-V1 or Proposed is required for V1.

---

## 1. Purpose and principles

A desktop app for one person (joshua) on Windows and Linux. You describe a web app; it plans it with you stage by stage, builds one feature at a time, checks it, previews it, and you press Keep or Undo and give a 1–5 rating.

The app has two jobs, in this order:

1. **Build projects.** Plan → build → check → preview → Keep/Undo. This is V1.
2. **Get better at choosing.** Learn which models, tools and ways of working do best, from real evidence. V1 only records the evidence. Using it in richer ways comes after V1 ("Capability Intelligence", §12).

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

## 2. Current verified architecture

```
          ┌──────────────────────────── desktop app ────────────────────────────┐
 joshua → │ React screens ──Tauri commands──▶ Rust shell ──JSON lines──▶ Engine │
          │                                   (keys in OS store)    (Node helper)│
          └──────────────────────────────────────────────────────────────┬──────┘
                    Engine uses: models · tools · memory · checks · gatekeeper
                    Stores: history.sqlite (this PC) · ai-prototype-data (GitHub) · project repos
```

| Part | Status | What exists |
| --- | --- | --- |
| Tauri shell + React screens | **Built** | Rail: Projects, Build, Tools, Settings. Projects and Build are placeholders until steps 7–8. |
| Engine helper | **Built** | Node process started by Rust; one JSON object per line on stdin/stdout; 13 methods (`ping`, `ask`, `check`, `settings_check`, `gate_check`, `gate_rules`, `spend_summary`, `data_overview`, `tool_rate`, `data_sync`, `settings_saved`, `history_list`, `undo`). |
| Keys | **Built** | OS password store (Windows Credential Manager, Linux Secret Service). Never written to a file or sent back to the screens. |
| Claude adapter | **Built** | Agent SDK; one turn, no tools yet; cost-capped. |
| OpenAI / DeepSeek adapter | **Partly built** | One `fetch` adapter; real-key runs not confirmed. |
| Memory: data repo read, ratings, sync | **Partly built** | Read, rate and sync work; habits writing and graph links are not used yet. |
| Spend + budget stop | **Built** | `spend` table; calls refused when the month's budget is used. |
| Gatekeeper + guard + own rules | **Partly built** | Rules and checks work; no agent action goes through them yet (no tool-using agent until step 8). |
| Undo history | **Built** | `changes` table; undo/redo for settings and data-folder files. |
| Checks | **Partly built** | `canKeep` and `isBigBuild` rules only. No runners yet. |
| Worktrees, plan interview, report, phone | **V1 planned** | Steps 7–10. |

Details and evidence: [audit §3](CURRENT_STATE_AUDIT.md#3-v1-progress-eleven-steps).

## 3. Tauri and React interface

- **Screens** (`apps/desktop/src`) only ask the engine, through Rust commands. They never call a model, tool, package manager or outside service. **Built.**
- **Rust shell** (`apps/desktop/src-tauri`) stays tiny: it opens the window, starts the engine, holds keys and reads/writes `settings.json`. Window permissions are `core:default` only. **Built.**
- **Settings file** `settings.json` (app config folder, no keys): provider, budget, £/$ rate, model choices, prices, data folder, joshua's extra rules. The agent can never edit it (guard in `engine/gate.ts`). **Built.**
- V1 screens still to come: plan interview (Projects), Using line + live steps + report + Keep/Undo + rating (Build), panel of items that need joshua (step 10). **V1 planned.**
- No Capability Centre screen in V1 (§12.6).

## 4. TypeScript/Node engine

`packages/engine`, the only orchestrator.

- **Built:** request handling (`protocol.ts`), budget policy (`budget.ts`: refuse when used up, per-call cap of at most $0.50 / about £0.40, 30% rule), the gate (`gate.ts`), settings checks (`settings.ts`), undo flow (`history.ts`), data-repo actions (`data.ts`), money in £ and $ (`money.ts`).
- **Exists but not wired:** `usingLine()`.
- **V1 planned (step 8, D-2):** count failures per tool; after 3 in a row, switch the tool off, tell joshua, and never pick it until he chooses retry, re-enable or uninstall.
- **V1 planned:** the eight-step task flow (§7), worktree per build, live step list, 2 fix attempts, sync after each task, routing every agent tool call through `gate()`.
- The engine makes **every** runtime choice of model and tools. Other parts give it facts and advice only.

## 5. Model adapters

`packages/models`. Every adapter has the same shape: `run({job, prompt, model}) → {text, usage}` with tokens and cost (cost `null` when the price isn't known).

- Claude through the Agent SDK, with a safe environment (only listed variables pass; its own config folder so it can't use another Claude login). **Built.**
- OpenAI and DeepSeek through one OpenAI-compatible adapter. The plan named the Vercel AI SDK as "likely"; plain `fetch` was used instead to avoid a dependency. A shared tool-using loop for these two is still to come. **Partly built.**
- Model per job: Opus plans and does final and security review; Sonnet builds and reviews plans; Haiku reads, summarises, writes tests and reviews code (Sonnet for security or multi-file changes). The table is in `CLAUDE_MODEL_BY_JOB` and copied in `rules.md`. They must stay in step ([audit §4.1](CURRENT_STATE_AUDIT.md#41-overlaps-and-conflicts-found) item 1).
- Models report usage. They don't decide budgets and they don't orchestrate.

## 6. Lazy tool execution

`packages/tools`.

- **Built:** the tool card format (`parseCard`: What, Use when, Don't use when, Cost) and the one-line summary the engine reads.
- **V1 planned:** a small runner per tool that starts only when the engine picks the tool (steps 8–9: Playwright screenshots, axe, phone-overflow, secretlint, npm audit, Only CLI).
- **V1 planned (D-2):** runners report each run's health (ok / failed and why) and notice a tool's version or config changing. They report this; memory stores it; the engine acts on it.
- Adding a tool means adding a card. Tools that cost money or send code or data to a new outside service need joshua's OK first (gatekeeper).
- **Not allowed (any release):** installing, enabling or removing a tool just because it scored well.

## 7. Task flow (unchanged from the plan)

1. You ask in plain words.
2. The engine reads short summaries of the ledger, habits and rules, and opens a full file only if unsure.
3. It picks the model and tools and shows `Using: …` first.
4. It builds in a git worktree, one feature per run, with a live step list.
5. It checks: tests (must pass), free checks, and the enterprise checklist rules for the areas touched. If tests fail: 2 automatic fix attempts, then stop and tell you.
6. It previews: desktop and phone pictures every build; Claude looks only when screens changed.
7. It reports what changed, tests, cost in £ and $, and pictures. You press Keep or Undo and give a 1–5 rating.
8. It learns and syncs: the ledger updates and the data repo syncs to GitHub.

Capability Intelligence (after V1) only feeds better facts into step 3 and better records into step 8. It adds no step.

## 8. Memory and private data repo

`packages/memory` owns all saved knowledge and history.

**Private data repo** `ai-prototype-data` (Markdown, synced to GitHub):

```
ledger.md        one line per tool: name | status | job | evidence | cost | rating
habits.md        joshua's habits; the app adds ones it notices and says so
rules.md         general tool rules; the app may edit and says so
tools/<name>.md  one card per tool
trials/          tool trial results
projects/<name>/ spec.md (features with IDs) and done/ (pass/fail per feature)
```

**Local database** `history.sqlite` (this PC only, Node's built-in SQLite, no extra package):

| Table | Status | Holds |
| --- | --- | --- |
| `spend` | **Built** | every model call: time, provider, model, job, tokens, $ cost |
| `changes` | **Built** | every settings or data-file change with exact before/after, for undo |
| task-run record | **Proposed for step 9** | which model and tools ran, tests, Keep/Undo, rating, linked to its spend rows |

The task-run record is the only new data foundation this doc suggests for V1. It's justified by step 9 (report + rating) and the plan's learning order (tests, rating, tokens/cost, Keep/Undo). It's a table in the same file, not a new database. It needs joshua's OK as part of step 9.

Tool health, failure history, stale evidence and re-test results are also memory's, written to the ledger and cards (step 5, D-2). Habits are written after a task by the step 9 learning pass, only with enough evidence, and joshua is told. `rules.md` stays above `habits.md` except below 30% of the budget.

Rules: keys never go in either store; sync refuses key-shaped text; sync never forces.

## 9. Checks and testing

`packages/checks` owns "did it work?".

- **Built:** `canKeep` (no Keep unless tests ran and every check passed) and `isBigBuild` (5+ features, or logins, payments or personal data).
- **V1 planned (step 9):** run the project's tests (Vitest), free checks (axe, phone overflow, secretlint, npm audit), checklist rules for touched areas, Playwright pictures; Haiku page-code and secret checks; paid and fresh-eyes reviews on big builds only.
- **Post-V1:** capability evaluations reuse these same runners (§12.4). No second test runner.
- This repo's own checks: `pnpm check` (typecheck, tests, secret scan) locally, and CI on Ubuntu and Windows (adds `pnpm audit` and `cargo test`).

## 10. Gatekeeper

`packages/gatekeeper` is joshua's. Agents never edit it.

- **Built:** six ask-first or never rules (key files: never; push, bulk delete, deploy, outside service, global install: ask). `engine/gate.ts` applies them unchanged, adds the `protect-rules` guard (the agent may never change the rules or `settings.json`) and joshua's own rules from Settings.
- **V1 planned (step 8):** every agent tool call goes through `gate()` before it runs.
- The gatekeeper is the **only** approval authority. Security findings, scores and recommendations can make the app *ask*; they can never *approve*.
- **Decided (D-3, 2026-11-11):** the `protect-rules` guard moves from `engine/gate.ts` into `packages/gatekeeper`, so the gatekeeper is the single authority for protected changes and approval rules. The engine keeps only the job of calling it. This is a separate code PR approved by joshua, and is not part of these docs. `rules.md` is **not** guarded (joshua, Option A): the app may update it and tell him afterwards, and each change goes into the `changes` history with Undo.

## 11. Git worktree isolation and the V1 build order

- Each build runs in its own git worktree of the project repo, one feature per run. **V1 planned (step 8).** Undo of project files = drop the worktree; Keep = merge it.
- Each website gets its own GitHub repo.

**V1 build order (unchanged, one PR each, tests passing on Windows and Linux before the next):**

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

There is no twelfth step. Capability Intelligence is not a V1 step.

## 12. Capability Intelligence

### 12.1 What it is

The app's evidence-based knowledge of what it can use: models, tools, plugins, skills, mods and extensions, agents, and workflows. It answers: what is this, which version, what evidence says it works for this job, what does it cost, what does it need, is it safe and allowed, and is the evidence still current?

It is **advice and records**, never a second engine, registry, memory, test runner or gatekeeper. It has **no package of its own**. Its jobs are spread over existing owners:

| Job | Owner |
| --- | --- |
| Where capability facts and evidence are stored | memory (ledger, cards, `history.sqlite`) |
| Card format and runners | tools |
| Usage and cost numbers | models |
| Running evaluations | checks |
| Ranking candidates and choosing | engine |
| Allowing risky use | gatekeeper |

A separate package is considered only if, after V1, a job can't live cleanly in one of these ([§20](#20-after-v1)).

### 12.2 What V1 already gives it (no new work)

| Foundation | Where | Status |
| --- | --- | --- |
| Trial results per tool | `trials/`, ledger evidence column | Built |
| One-line summaries, cards | `tools/*.md`, `firstRead` | Built |
| Tool rating 1–5 | ledger rating column | Built |
| Token and cost per call | `spend` table | Built |
| What was actually used | `Using:` line | Step 8 |
| Tests, Keep/Undo, task rating | task-run record | Step 9 (proposed table) |
| Baseline + stale on update | step 1 rule, memory records | Rule written; code not built (D-2) |
| Tool health, failures, re-tests, habits saved | memory | Step 5 follow-up (D-2) |
| 3-failures-off | engine | Step 8 (D-2) |
| Learning into `habits.md` | memory, triggered by engine | Step 9 (D-2) |

### 12.3 Capability kinds and what to measure (Post-V1)

| Kind | Examples of what matters |
| --- | --- |
| Models | task success, code quality, following instructions, tool use, cost, speed |
| Tools | does its job, reliability, error handling, speed, output correct |
| Plugins | permissions, data handling, reliability, dependencies, can be removed cleanly |
| Skills | triggers at the right time, clear, consistent, token overhead, conflicts |
| Mods / extensions | source integrity, compatibility, stability, permissions, reversible |
| Agents | stays in scope, tool-use accuracy, cost per task, hand-off quality |
| Workflows | end-to-end success, defects, total cost, time, how often joshua had to step in |

### 12.4 Evaluation (Post-V1)

Discovery → registration (a card) → source and version check → reading the docs and source → functional, speed and reliability tests → security, compatibility and dependency checks → cost measurement → evidence saved → comparison with history → recommendation.

- Every result names the capability **version** and the **environment** (OS, Node, project).
- Tests run through `packages/checks`, on test data where possible. Private project code isn't sent to a new service without joshua's OK.
- A 1–3 run trial is a screening result, not a benchmark, and is shown that way.

### 12.5 Scoring (Post-V1)

Six measures, kept apart:

| Measure | Question |
| --- | --- |
| Capability quality | How well does it do its job? |
| Task suitability | How well does it fit this task? |
| Trust and security | Is it safe and allowed? (pass / restricted / blocked / not checked) |
| Cost efficiency | Tokens, money, time |
| User satisfaction | joshua's 1–5 ratings |
| Evidence confidence | How many runs, how recent, how complete |

- An optional 0–100 score may be added later, with weights per kind that joshua can see. It's never one universal star rating.
- **A security or policy failure can't be outweighed by a high score.** Blocked is blocked.
- **Untested stays "untested"**, never 0.
- The user's rating is never silently mixed into the automatic scores.

### 12.6 Screens

None in V1, apart from what the Tools page already shows. A Capability Centre (registry, evaluations, comparisons, compatibility, lifecycle) is **Post-V1** and only once real data backs every number on it.

## 13. Supporting intelligence systems

These are **jobs, not packages**. Each has one owner. All are Post-V1 unless the "V1 part" column says otherwise, and that part is already in the plan.

| System | Does | Owner | V1 part (already in plan) |
| --- | --- | --- | --- |
| A. Environment and compatibility | runtime, package, tool and version fit; conflicts; duplicates; dependency graph | checks (tests) + memory (records) | Windows/Linux CI; pnpm 10 pin rule |
| B. Security and trust | source, dependency, permission, data, network and file access review; findings | checks (finds) → gatekeeper (decides) | secretlint, npm audit, Haiku secret check, gatekeeper |
| C. Workflow | which mixes of models, tools, skills and agents work best per job type | engine (uses) + memory (stores outcomes) | per-job model table |
| D. Experiment and learning | fair comparisons, repeatable tests, before/after, regressions, learning from real tasks | checks (runs) + memory (stores) | tool trials; Keep/Undo; 1–5 rating |
| E. Capability lifecycle | discovered → inspected → evaluated → approved → in use → stale → retired | memory (ledger status, cards) | ledger status column; stale and 3-failures rules (steps 1, 5, 8 per D-2) |
| F. Resources | tokens, $ and £, time, cost per successful task, retries, forecasts | models (report) + engine (budget) + memory (store) | spend table, budget stop, 30% rule |
| G. Knowledge and docs | read capability docs, extract needs, spot old or conflicting instructions | memory (cards, notes) | summaries first; cards |
| H. Project | each project's spec, stack, limits, approved tools, decisions | memory (`projects/<name>/`) + engine | plan interview spec + done files (step 7) |
| I. Recovery and change | version-aware rollback, config recovery, change impact, post-change checks | memory (`changes`) + engine (worktrees) | undo history; worktrees (step 8) |

Rules that keep these from becoming duplicates:

- B never approves anything. It reports; the gatekeeper decides.
- C never runs tasks. It advises; the engine runs them.
- E extends the ledger and cards. It's not a second inventory.
- F extends the `spend` table and `budget.ts`. It's not a second cost engine. £20 budget, possible £40, 30% rule unchanged.
- G and H use the existing memory. No second memory system. Project facts stay apart from joshua's global habits.
- I extends `changes` and worktrees. Nothing is assumed rolled back without checking.

## 14. Who owns what

| Owner | Owns | Must never become |
| --- | --- | --- |
| `apps/desktop` | screens, Rust shell, keys, settings file | a model or tool runner, or a rule authority |
| `packages/engine` | task flow, model/tool choice, worktrees, retries, budget policy, applying the gate, `Using:` line, 3-failures rule | an evaluator, a store, a rule editor |
| `packages/models` | provider adapters, usage and cost reports, per-provider model defaults | an orchestrator |
| `packages/tools` | card format, lazy runners, tool health and version/config change reports | an installer, a second registry |
| `packages/memory` | data repo, ledger, habits, rules, cards, graph, `history.sqlite`, sync, all evidence records, tool health and stale evidence, learning history | a second database, or a writer of joshua's preferences without telling him |
| `packages/checks` | tests, free checks, pictures, Keep rule, big-build rule, future evaluation runs | a workflow engine or approver |
| `packages/gatekeeper` | ask-first and never rules, and the guard that protects them (joshua only) | something the agent or a score can change |
| `templates/web-app` | standard stack starter | a registry |

## 15. Data flow and boundaries

```
request → engine
        → reads summaries (memory) + capability evidence (memory, Post-V1)
        → picks model and tools, shows Using line (engine)
        → risky step? gatekeeper asks joshua
        → build in worktree (engine, models, tools)
        → checks (checks) → pictures → report
        → Keep/Undo + rating (joshua)
        → records + ledger + sync (memory)
        → later: re-evaluate when something changed (checks via engine, Post-V1)
```

Dependency direction (no cycles): desktop → engine → {models, tools, memory, checks, gatekeeper}; memory → tools (card parsing). Gatekeeper depends on nothing. Capability Intelligence adds no new arrows; it reads memory and is called by the engine.

| Item | Rule |
| --- | --- |
| Inputs to choosing | summaries, evidence, budget state, project spec |
| Outputs | `Using:` line, run record, ledger/cards updates |
| Evidence source | every record names where it came from (trial file, run id, CI run) and its date |
| Versioning | records carry the tool or model version where known; "unknown" otherwise |
| Failure | a tool that fails is reported as failed, never as passed; completed work is kept |

## 16. Security and trust boundaries

- Keys: OS password store only. Passed to the engine for one call. Never in chat, Markdown, GitHub, logs, prompts or pictures.
- Outside services: asking first is required for anything that costs money or sends code or data somewhere new.
- Claude runs with a fixed environment and its own config folder.
- Imported tools, plugins, skills, mods, packages and docs are untrusted until checked. Post-V1 evaluation runs them isolated, with least permissions and test data.
- The app may change itself only when the change is small, all tests pass, and it doesn't touch security, keys, payments, deploys or approval rules.
- Nothing installs, enables, disables or removes a capability because of a score.

## 17. Compatibility and lifecycle

- **V1:** CI on Ubuntu and Windows; template rules (pnpm 10 pinned, shadcn via npx). Lifecycle = the ledger status column (ON, BACKUP, TRIAL, NOT TESTED, NOT NEEDED, OFF).
- **Plan rules, not yet built:** tool update → old results stale → re-test on next use; 3 failures in a row → tell joshua and switch off; uninstall decided together.

**Tool lifecycle split (joshua, 2026-11-11, decision D-2):**

| Step | Its part |
| --- | --- |
| 1 Tool trials | The first test and reliability baseline for each tool. When a tool updates, its earlier results are marked stale and a re-test is due on next use. |
| 5 Memory and data repo | Saves tool health, failure history, stale evidence, re-test results and habits; updates tool cards and the data repo records. |
| 8 Build loop | Enforces "3 failures in a row": switch the tool off, tell joshua, and never pick it again until he chooses retry, re-enable or uninstall. Switching off never uninstalls. |
| 9 Check, preview and report | After Keep/Undo and the rating, learns: spots repeated preferences, updates `habits.md` once there's enough evidence, and tells joshua. |

Owners: **engine** enforces failure handling and skips switched-off tools; **tools** runs tools and notices health and version or config changes; **memory** owns tool records, stale evidence, habits and learning history. `rules.md` stays above `habits.md`, except below 30% of the monthly budget (P-03). No new system, registry or service.
- **Post-V1:** version fields on cards; compatibility results per environment; update *detection* (separate from installing); stale detection; retirement suggestions. Card file name is the stable ID (no new registry).

## 18. Evaluation and scoring concepts

See §12.4–12.5. Conceptual records for after V1, to be added to `history.sqlite` and cards **only after checking the schema then current**:

- Capability (stable name = card file name, kind, source)
- Capability version (version, config, dependency fingerprint)
- Evaluation run (suite, environment, date, outcome)
- Evidence item (case, result, numbers, link)
- Selection decision (task, candidates, choice, reason)
- Usage (run id, tokens, cost, time, errors, outcome)
- Relationship (requires, conflicts with, overlaps, used by)

These are ideas, not V1 tables.

## 19. Failure and recovery

- Tests fail → 2 fix attempts → stop and report (V1).
- Budget used up → calls refused with a plain message (built).
- Sync clash → stop, keep the local change, say so; never force (built).
- Undo when something changed since → refuse and touch nothing (built).
- Tool fails 3 times in a row → off, tell joshua, not picked again until he decides; never uninstalled automatically (step 8).
- Evaluation tool unavailable → "blocked" or "not run", never "passed".
- Project-file undo → drop the worktree (step 8).

## 20. After V1

The plan's "after Version 1" list: deploy and client handover, self-improvement, update watching, tool clean-up, more phone actions. Capability Intelligence fits under self-improvement, update watching and tool clean-up. Suggested order (**Proposed**):

1. Tidy the foundations: stable card IDs, version fields, stale handling.
2. Compatibility and evidence records per environment.
3. Repeatable evaluations per capability kind, run through checks.
4. Workflow comparisons feeding engine choice.
5. Controlled experiments and regression checks.
6. Update detection with joshua's approval to adopt.
7. Project-specific recommendations; doc reading.
8. Wider recovery (config and failed-update rollback).

A new package or screen is added only with evidence that an existing owner can't hold the job, and with joshua's OK.

### Change rules for this document

A change must state: the code evidence, the existing owner considered first, why it isn't enough, data and migration impact, gatekeeper and cost impact, Windows and Linux impact, tests and rollback, and whether it touches the V1 order. Anything that changes the V1 order, adds an approval authority, duplicates a store, or weakens a safety rule needs joshua's explicit OK.

# AI-prototype-application: product requirements

**Status:** working PRD, 2026-11-12. Checked against the code at `99ac216` (merge of PR #56). The previous version described `c2b3fcf` (11 Nov, step 6b).
**Authority:** the Claude Doc "AI-prototype-application: full plan" (10 Nov 2026). If this file disagrees with it, the plan wins.
**Related:** [System architecture](SYSTEM_ARCHITECTURE.md) · [Current-state audit](CURRENT_STATE_AUDIT.md)

**Words used:**

- **MUST** = required for its release.
- **SHOULD** = expected unless there's a good reason, written down.
- **COULD** = nice to have.

Releases: **V1** (the eleven steps) and **Post-V1**. No Post-V1 requirement is needed for V1 to be accepted.

Each requirement lists: priority, owner, depends on, release, status (from the [audit](CURRENT_STATE_AUDIT.md)), what it is, and how we know it's done.

**Evidence labels (the same in all three docs):**

| Label | Meaning |
| --- | --- |
| **Verified** | Code + tests + real-use evidence |
| **Implemented** | Code + unit tests, no real-use proof yet |
| **Partial** | Some of it is built; the rest is not |
| **Missing** | Not in the code |
| **Planned** | In the roadmap, not started |

Real-use evidence that exists (given, from the private data repo): the first real build, Club HR F-01, passed on 12 Nov (£0.09 / $0.11); the free tests (CI-3) for secretlint, axe-core, playwright and checklist-rules passed on one computer; the environment check (CI-2) ran on one computer; update look-up (CI-6) ran and 9 updates were OK'd. The phone flows, the live view, CI-4, CI-5, CI-7 and CI-8 have no real-use record yet. A merged PR alone never makes a requirement Verified.

---

## 1. Product

A desktop app for one person, joshua, on Windows and Linux (no macOS). You describe a web app; the app plans it with you stage by stage, builds it cheaply and well one feature at a time, checks and previews it, and you press Keep or Undo and give a 1–5 rating. First real use: the Club HR website; later a SaaS school platform and client apps, with client handover in about 6 months (after V1).

## 2. User and goals

**User:** joshua only. Plain words, short replies, money in £ and $. Starts tasks from the PC and follows or answers from his phone. Two Windows laptops; a Linux machine planned.

**Goals:**

1. A reliable plan → build → check → preview → Keep/Undo loop.
2. Small builds that are easy to trace and easy to undo.
3. Only the models and tools a job needs.
4. Real tokens, costs, results and ratings recorded.
5. Keys, outside services and spending behind clear safeguards.
6. Learning from tests, ratings and Keep/Undo.
7. A base for smarter capability choices later, without growing V1.

## 3. Core principles (from the plan)

| ID | Principle |
| --- | --- |
| P-01 | Every choice is judged on tokens first, then quality, then price. Quality first for planning, final review and security. Price comes last unless the month's spend would pass the budget. |
| P-02 | Budget £20 a month, may rise to £40. Costs shown in £ and $ with the rate used. |
| P-03 | General rules win while more than 30% of the budget is left; below that joshua's preference wins, and the app says so. |
| P-04 | Tools are off until needed; token savers may stay on. One tool per job. Every tool is tested for its job before it's trusted. |
| P-05 | A tool that fails 3 times in a row: tell joshua, switch it off, decide together about uninstalling. |
| P-06 | Learning order: tests passing, the 1–5 rating, tokens and cost, Keep or Undo. |
| P-07 | Habits the app notices go in `habits.md`, and it says so. When a tool updates, its old results are stale and it's re-tested on next use. |
| P-08 | Short replies; details on request; fresh chat with a handoff note at about 150k tokens; wrap up after about 45 minutes idle. |
| P-09 | Every change to files, settings or tools keeps history with one-click undo. |
| P-10 | Safety rules (never broken): keys only in Settings; ask first before anything that costs money or sends code or data to a new outside service; the app changes itself only when the change is small, tests pass, and it doesn't touch security, keys, payments, deploys or approval rules; tests must always pass and are never cut. |

P-05 and P-07 had no named build step in the plan. joshua decided on 2026-11-11 (D-2) to spread them over steps 1, 5, 8 and 9 ([audit §6](CURRENT_STATE_AUDIT.md#6-decisions-for-joshua)). All of that is now in code (**Implemented**). Since 12 Nov (Q-3) only the model's own failures count towards P-05: a cost limit, network drop, busy provider, bad key, no credit or a Stop does not. `rules.md` stays above `habits.md`, except below 30% of the budget (P-03).

## 4. V1 scope: the eleven steps (unchanged; status as of 12 Nov)

One pull request per step (steps may be split into smaller PRs, as steps 3–6 were). Each step passes its tests on Windows and Linux before the next starts.

### V1-01 Tool trials (cloud)
- MUST · Owner: memory (records) · Depends: none · V1 · **Verified** (EGM ledger line per D-1 can't be checked from here; the stale rule is now in code, see CAP-V1-05)
- Token savers first, including Only CLI; then code quality, testing and website helpers; EGM tried for planning; 1–3 runs per job; account tools (Vercel, Figma) skipped. Results go into the first ledger and tool cards.
- Done when: every trialled tool has a ledger line and card with job, evidence, cost and status; untested tools say "NOT TESTED".
- Also (D-2): trial results are each tool's baseline. When a tool updates, the old results are marked stale and a re-test is due on next use.

### V1-02 Repo setup
- MUST · Owner: repo · Depends: none · V1 · **Partial** (setup Verified; CI not running)
- The monorepo, a short `CLAUDE.md`, and automatic checks on Windows and Linux.
- Done when: CI runs typecheck, tests and secret scan on both systems and passes.
- Now: the workflows exist (PR #49 repaired them) but no GitHub Actions job has started since 11 Nov 19:12 UTC (account billing), and branch protection isn't available on the private free plan, so checks can't be required. Until Actions runs again the only gate is the local `pnpm check`.

### V1-03 Window and screens
- MUST · Owner: apps/desktop · Depends: V1-02 · V1 · **Verified**
- The Tauri shell, a React skeleton, the engine helper starting up, and Settings with the encrypted key.
- Done when: the window opens on Windows and Linux, shows the engine running, and saves a key to the OS password store without ever showing it again.

### V1-04 Model adapter
- MUST · Owner: models · Depends: V1-03 · V1 · **Verified** for Claude; **Implemented** for OpenAI/DeepSeek (no real-key run; they can't build, only Claude can)
- Claude through the Agent SDK first, with OpenAI and DeepSeek adapters behind the same setting.
- Done when: one setting switches provider; each adapter reports tokens and cost (or "cost unknown"); Claude-only extras that don't carry over are tracked per model in the ledger.

### V1-05 Memory and data repo
- MUST · Owner: memory (+ engine for the Using line) · Depends: V1-04 · V1 · **Implemented** (the Using line and sync after each task are wired into the build loop; real-use record only through CI-2, CI-3 and CI-6)
- The three files, tool cards, memory-graph links, the Using line, and automatic sync after each task.
- Done when: the engine reads summaries first; ledger/habits/rules/cards load from the data folder; the Using line shows before each run; the data repo syncs after each task without forcing and without keys; cost and undo history are in local SQLite.
- Also (D-2): tool health, failure history, stale evidence, re-test results and habits are saved, with tool cards and data repo records updated. *Built (CI-1, `tool-health/`). Implemented; no separate real-use record.*

### V1-06 Gatekeeper and undo
- MUST · Owner: gatekeeper (rules) + engine (applies them) + memory (history) · Depends: V1-05 · V1 · **Implemented**; in the path of every build tool call (see §9). No real-use record of a refusal.
- The ask-first rules, plus one-click undo for files, settings and tools.
- Done when: every risky agent step is checked before it runs; the agent can't edit the rules or settings; settings, data files, project files (via worktree) and tool changes can be undone in one click, and undo refuses safely if things changed since.

### V1-07 Plan interview
- MUST · Owner: engine (flow) + desktop (screen) + memory (spec storage) · Depends: V1-06 · V1 · **Implemented** (the spec path is **Verified**: F-01 needed a finished plan; Claude's suggestions and the reviews have no separate real-use record)
- The stage-by-stage questions, ending in a spec with IDs and done files. Stages: idea; who it's for and goals; features; enterprise checklist areas; look and brand; tech (standard stack unless told otherwise); what "done" means. All of a stage's questions in one message, related tools listed first, no moving on until joshua confirms. Planning trialled with EGM.
- Done when: a finished interview writes `projects/<name>/spec.md` with feature IDs and one pass/fail done file per feature; big plans (P-11 below) get the fresh-eyes review.

### V1-08 Build loop
- MUST · Owner: engine · Depends: V1-07 · V1 · **Verified** for one real build (F-01); fix attempts and the 3-failures switch-off are **Implemented**
- One feature per run in a worktree, a live step list, and 2 fix attempts.
- Done when: each run uses its own git worktree; one feature per run; the live step list updates; after 2 failed fix attempts the run stops and says so; every agent tool call passes the gate.
- Also (D-2): a tool that fails 3 times in a row is switched off, joshua is told, and the engine won't pick it until he chooses retry, re-enable or uninstall. Switching off never uninstalls.

### V1-09 Check, preview and report
- MUST · Owner: checks + engine + desktop + memory · Depends: V1-08 · V1 · **Verified** for tests, free checks and pictures (first real run); Keep, Undo, rating and learning **Implemented**
- Tests, free checks, checklist rules, pictures, the report in £ and $, Keep or Undo, and the rating.
- Done when: tests must pass for Keep; free checks run every build; desktop and phone pictures every build, looked at by a model only when screens changed; the report shows changes, tests, cost in £ and $ and pictures; Keep/Undo and a 1–5 rating are recorded; paid and fresh-eyes reviews only on big builds.
- Also (D-2): after Keep/Undo and the rating, the app looks for repeated preferences, updates `habits.md` only when there's enough evidence, and tells joshua what it added or changed.

### V1-10 Phone messages
- MUST · Owner: engine (+ desktop panel) · Depends: V1-09 · V1 · **Implemented** (no real-use record)
- GitHub updates, work items, and a panel of items that need joshua.
- Done when: the app posts to GitHub when a task finishes or needs him; he can answer and press Keep or Undo from his phone; the panel lists only items needing him.

### V1-11 First real run
- MUST · Owner: all · Depends: V1-10 · V1 · **Partial**
- One Club HR feature end to end on joshua's Windows PC, then a Linux check once he has the machine.
- Done when: one real feature goes through all eight task steps with real evidence for each.
- Now: F-01 built and passed on 12 Nov (£0.09 / $0.11). Not shown yet: real evidence for every one of the eight steps, and the Linux check.

### Rules that apply across V1

| ID | Rule | Owner |
| --- | --- | --- |
| P-11 | Fresh-eyes and paid reviews only on big builds: 5+ features, or logins, payments or personal data. Full enterprise checklist once before an app is called done. | checks (`isBigBuild`) |
| P-12 | Standard stack: Next.js + TypeScript, Postgres on Neon, Auth.js, shadcn/ui with Sonner, Vaul and cmdk, unless a project says otherwise. | templates/web-app |
| P-13 | Model per job: Opus plans, final and security review; Sonnet builds and reviews plans; Haiku reads, summarises, writes tests, reviews code (Sonnet for security or multi-file). | models (defaults), engine (choice) |

### V1 acceptance

V1 is done when V1-11 passes: one real Club HR feature through planning, choice of model and tools, worktree build, required checks, pictures, £/$ report, Keep/Undo, rating and data sync, on Windows, with the Linux check done when a machine is available. Screens or packages existing don't count on their own.

**Where that stands (12 Nov):** F-01 built and passed. The build, tests, free checks and pictures have real-use evidence. Keep/Undo, rating, data sync of the real data repo, the phone and the Linux check are not recorded yet, so V1 is **not** accepted yet.

### Not in V1

Things built *after* the eleven steps, as separate PRs (V2 A to D, CI-1 to CI-8, Capability Centre), are not V1 requirements. They are listed in §5 with their real status.

Still not allowed or not built:

- 0–100 scores, benchmark suites, A/B routing. (Workflow comparisons exist as advice only, CI-4.)
- Installing, updating, disabling or removing plugins, skills or mods automatically. The update look-up (CI-6) never installs.
- Self-changes beyond the small-change rule; any change to gatekeeper rules by the app. Q-5 (narrow self-maintenance, approved 12 Nov) is for Phase 3 and nothing is built.
- Agent teams beyond what the build loop needs.
- Deploy and client handover.
- Phone actions beyond V1-10 and V2 D (start a build, answer the model's questions).

## 5. Capability Intelligence requirements

Capability Intelligence = the app's evidence about what it can use (models, tools, plugins, skills, mods and extensions, agents, workflows), used to advise the engine. Owners are existing packages ([architecture §12](SYSTEM_ARCHITECTURE.md#12-capability-intelligence)). It never chooses, runs or approves anything itself.

### 5.1 V1 foundations (already inside V1 steps; nothing new)

(Statuses are from the code at `99ac216`.)

#### CAP-V1-01 Trial records
- MUST · Owner: memory · Depends: V1-01 · V1 · **Verified**
- Each trial is recorded with job, runs, result, cost, issues and recommendation in the ledger and cards.
- Done when: failed, skipped and passed trials are distinguishable; unknown numbers stay unknown; trials are marked as screening (1–3 runs), not benchmarks.

#### CAP-V1-02 Cards and summaries
- MUST · Owner: tools (format) + memory (storage) · Depends: V1-05 · V1 · **Implemented**
- One card per tool (What, Use when, Don't use when, Cost) and a one-line summary for choosing.
- Done when: the engine chooses from summaries without opening every card; `tools/<name>.md` stays the one card store.

#### CAP-V1-03 Record what was actually used
- MUST · Owner: engine · Depends: V1-08 · V1 · **Verified** (the build loop shows the `Using:` line)
- The `Using:` line shows the model and tools actually picked, for every run.
- Done when: the line matches what ran; tools not picked don't start.

#### CAP-V1-04 Link use to outcome
- MUST · Owner: memory (record) + engine (writes it) · Depends: V1-09 · V1 · **Partial**
- Each run's model, tools, tokens, cost, test result, Keep/Undo and rating are linked. The `runs` table in `history.sqlite` gets a row at the start of every build; its id is the build ID, also stored on spend rows. Failed builds are saved with a cause, the error and cost so far; stopped and interrupted builds are saved too (#57).
- Done when: the app can say which model and tools a run used and how it went; test results and joshua's rating are stored separately.

#### CAP-V1-05 Stale evidence and 3-failures rule
- MUST (plan principles P-05, P-07) · Owner: engine (enforces failures, skips switched-off tools) + tools (health, version/config changes) + memory (records, stale evidence, habits) · Depends: V1-01, V1-05, V1-08, V1-09 · V1 (split per D-2) · **Implemented** (all four parts in code; no real-use record of a switch-off, a stale mark clearing in a build, or a learned habit)
- When a known tool or model version changes, old results are tagged stale and it's re-tested on next use (step 1 baseline, step 5 records). 3 failures in a row → tell joshua, switch off, don't pick it until he decides (step 8). Habits are learnt after Keep/Undo and rating (step 9).
- Done when: stale results show as stale; switched-off tools show as OFF with the reason and are never picked; nothing is uninstalled without joshua; each habit change is reported to him.
- Q-3 (12 Nov): only the model's own failures count towards the 3 in a row.

### 5.2 After the eleven steps: Capability Intelligence items

These were planned for after V1. Part of them was built on 12 Nov as CI-1 to CI-8 and the Capability Centre. Each status below says what the code really does.

#### CAP-01 Versioned capability profiles
- SHOULD · Owner: memory · Depends: CAP-V1-02 · Post-V1 · **Partial**: the card file name is the stable ID and versions are kept per tool (CI-1, **Implemented**). The rest of the profile (source, permissions, data access, workflows that use it) is **Missing**.
- One profile per capability (stable name = card file name) and per version: kind, source, purpose, needs, permissions, data access, cost, status, evidence, workflows that use it.
- Done when: unknown source, version or install scope shows as "unknown"; cards and ledger are extended, not copied.

#### CAP-02 Evaluations by kind
- SHOULD · Owner: checks (runs) + memory (stores) · Depends: CAP-01 · Post-V1 · **Partial**: repeatable free tests for the free-check tools (CI-3) are **Verified** on one computer (secretlint, axe-core, playwright, checklist-rules). Suites for models, plugins, skills, mods, agents and workflows are **Planned**.
- Repeatable tests suited to each kind (see §6).
- Done when: each suite states its aim, inputs, expected result, environment, permissions and pass rule; runs use checks' runners and test data; results are passed / failed / skipped / blocked / not run, with evidence links.

#### CAP-03 Separate measures
- SHOULD · Owner: memory (stores) + engine (reads) · Depends: CAP-02 · Post-V1 · **Partial**: the Capability Centre keeps tests, builds, health and joshua's rating apart, shows "Not tested" rather than 0, and adds nothing into a grade (**Implemented**). The optional 0–100 score with published weights is **Planned**.
- Capability quality, task suitability, trust and security, cost efficiency, user satisfaction and evidence confidence, kept apart.
- Done when: an optional 0–100 score uses published weights per kind; per-measure results and run counts stay visible; untested isn't 0; a security, permission, compatibility or required-test failure can't be outweighed; joshua's rating isn't mixed into automatic scores.

#### CAP-04 Confidence and freshness
- SHOULD · Owner: memory · Depends: CAP-02 · Post-V1 · **Missing**: results show their date and version where known, and stale marks exist (CI-1), but there is no per-result confidence (run count, small-sample label) anywhere yet.
- Done when: run count, date, environment and version show with every result; small samples are labelled screening; new versions are tested, not given old scores.

#### CAP-05 Comparisons
- COULD · Owner: checks + memory · Depends: CAP-03 · Post-V1 · **Partial**: whole-workflow comparisons from real builds (kept, defects, cost, time, Undo) are **Implemented** (CI-4, advice only, no real-use record). Experiments run a tool's free test several times and save a proposal (CI-5, **Implemented**). Comparing other kinds of candidate is **Planned**.
- Done when: candidates use the same inputs and environment; failures of hard gates make a candidate ineligible, not a loser; sample size and doubt are shown.

#### CAP-06 Recommendations
- SHOULD · Owner: engine (decides) using memory evidence · Depends: CAP-03 · Post-V1 · **Partial**: the Capability Centre lists next steps from real records, and the engine adds a suggestion only when a way of building has clearly done better over enough builds with no safety failure (**Implemented**; it never installs or switches anything). Explaining evidence age and fit for each is **Missing** (needs CAP-04).
- Done when: each recommendation explains fit, evidence age, quality and cost; it respects budget, compatibility and gatekeeper; it never installs or switches on anything; the engine still makes the final choice.

### 5.3 Other items built after the eleven steps

| Item | Owner | Label | Note |
| --- | --- | --- | --- |
| V2 A live view | checks + desktop | **Implemented** | The build copy's own page on 127.0.0.1 while the model works. No real-use record. |
| V2 B honest report | engine | **Implemented** | What the summary claims, set beside the app's own results. |
| V2 D phone: start a build, questions, pictures | engine | **Implemented** | Same rules as a PC build (finished plan, budget, run limit, one at a time, gatekeeper on every step). No real-use record. |
| CI-2 compatibility per computer | checks + memory | **Verified** | Ran on one computer; comparing two computers hasn't happened. |
| CI-6 update look-up | checks + memory | **Verified** | 9 updates OK'd. The app never installs an update; it shows the command for joshua. |
| CI-7 tools per project, docs reading | engine + memory | **Implemented** | SUP-G and SUP-H parts. Free safety checks always run. |
| CI-8 going back, checking it worked | engine + memory | **Implemented** | |
| UI-01 Capability Centre | desktop + engine | **Implemented** | Real records only. |

## 6. What to evaluate, by kind (Post-V1)

| ID | Kind | Must cover |
| --- | --- | --- |
| EVAL-01 | Models | task success, coding quality, following instructions, tool use, context handling, cost, speed |
| EVAL-02 | Tools | does its job, reliability, error handling, speed, correct output |
| EVAL-03 | Plugins | permissions, data handling, reliability, dependencies, clean removal |
| EVAL-04 | Skills | triggers at the right time, clarity, consistency, token overhead, conflicts |
| EVAL-05 | Mods / extensions | source integrity, compatibility, stability, permissions, reversible |
| EVAL-06 | Agents | stays in scope, tool-use accuracy, cost per task, hand-off quality |
| EVAL-07 | Workflows | end-to-end success, defects, total cost, time, how often joshua stepped in |

All SHOULD · Owner: checks (runs) + memory (stores) · Depends: CAP-02 · Post-V1. EVAL-02 (tools) is **Partial** (free-check tools only, CI-3, **Verified** on one computer). EVAL-01 and EVAL-03 to EVAL-07: **Planned**; EVAL-07 (workflows) has only the advice-only CI-4 comparison (**Implemented**). Done when: each kind has its own rubric; scores from different kinds are not compared as if alike.

## 7. Supporting intelligence requirements (Post-V1)

Each is a job with one owner, not a new package.

| ID | System | Owner | Done when |
| --- | --- | --- | --- |
| SUP-A | Environment and compatibility | checks + memory | status is compatible / incompatible / conditional / unknown / not tested; affected versions and workflows named; a possible duplicate isn't called a conflict without a test |
| SUP-B | Security and trust | checks (finds) → gatekeeper (decides) | each report states its scope and limits; untrusted code runs only isolated; findings can make the app ask, never approve |
| SUP-C | Workflow | engine + memory | engine stays the only runner; whole-workflow results (quality, defects, cost, time, interventions) are measured; the simplest workflow that works wins unless evidence says otherwise |
| SUP-D | Experiment and learning | checks + memory | each experiment has a question, fixed inputs, measures and a saved result; private code isn't sent to a new service without OK; results are proposals until adopted; Keep/Undo and rating unchanged |
| SUP-E | Capability lifecycle | memory | discovered, inspected, evaluated, approved, in use, stale, retired are separate states in the ledger; update *found* ≠ update *installed*; adopting a new version needs evaluation and OK |
| SUP-F | Resources | models + engine + memory | £/$ with rate and date; cost per successful task and retry overhead from the `spend` and run records; missing numbers stay missing; budget rules unchanged (£20, maybe £40, 30%) |
| SUP-G | Knowledge and docs | memory | doc facts keep their source; old or conflicting instructions are flagged; one-off notes don't become rules without joshua's review |
| SUP-H | Project | memory + engine | each project's spec, stack, limits and approved tools live under `projects/<name>/`; project rules beat general habits for that project; projects don't leak into each other |
| SUP-I | Recovery and change | memory + engine | each change has a recorded before/after or worktree; risky changes get an impact check and a way back; a rollback is checked, not assumed |

All SHOULD unless noted · Release Post-V1 · Depends: CAP-01 (and SUP-B also on the gatekeeper as it is).

Status now: SUP-A **Partial** (environment check **Verified** on one computer; duplicates listed; conflict tests **Missing**). SUP-B **Partial** (secretlint, audit, new-packages check and the gatekeeper exist; no wider review). SUP-C **Implemented** (CI-4, advice only). SUP-D **Implemented** (CI-5 and habit learning). SUP-E **Implemented** (lifecycle states in the Centre; update found ≠ update installed, CI-6 **Verified**). SUP-F **Implemented** (spend table, budget stop, cost per build; cost per *successful* task needs run records, **Planned**). SUP-G **Implemented** (CI-7 flags old or clashing lines; flags only). SUP-H **Verified** for the spec (F-01), **Implemented** for tools and rules per project. SUP-I **Implemented** (CI-8).

## 8. Non-functional requirements

| ID | Requirement | Priority | Release |
| --- | --- | --- | --- |
| NFR-01 | Works on Windows and Linux; CI on both; platform differences (paths, shells, keyring) handled explicitly. **Partial:** CI is written for both but not running (billing); Windows is untested for the sandbox environment and for links and junctions | MUST | V1 |
| NFR-02 | Token-light: summaries first, tools loaded only when picked, no idle agents | MUST | V1 |
| NFR-03 | Failures reported honestly; retries limited (2 fix attempts); work isolated per worktree. **Verified** for one build; failed builds are saved with their cause (#57, **Implemented**) | MUST | V1 |
| NFR-04 | Enough records to explain choices, costs, failures and changes, without keys or unneeded private code | MUST | V1 |
| NFR-05 | Small packages with one job each; swappable adapters; no parallel stores | MUST | V1 |
| NFR-06 | Status words are exact: passed, failed, skipped, blocked, not run, stale, unknown | MUST | V1 |
| NFR-07 | Untrusted capability code never runs inside the main app process | MUST | Post-V1 (no such code runs in V1) |

## 9. Security and privacy requirements

| ID | Requirement | Priority | Owner | Release | Status |
| --- | --- | --- | --- | --- | --- |
| SEC-01 | Keys only in the OS password store via Settings; never in chat, Markdown, GitHub, logs, prompts or pictures | MUST | desktop + models | V1 | **Verified** |
| SEC-02 | Ask first before spending money or sending code or data to a new outside service | MUST | gatekeeper | V1 | **Implemented**: the rules run on every build tool call; an ask goes to Needs you (Allow once / No, single use, 24 hours). No real-use record of a refusal |
| SEC-03 | The agent can never edit or get around gatekeeper rules or settings; rule changes only through Settings with joshua's approval | MUST | gatekeeper | V1 | **Implemented**: the guard (`protectRules`) now lives in `packages/gatekeeper` and always runs first (D-3). `rules.md` isn't guarded (Option A); the app doesn't write it yet |
| SEC-04 | Data repo sync refuses key-shaped text and never forces | MUST | memory | V1 | **Implemented** |
| SEC-05 | Claude runs with an allow-listed environment and its own config folder | MUST | models | V1 | **Verified** (used in the real build) |
| SEC-06 | Nothing is installed, enabled, disabled or removed because of a score | MUST | engine | all releases | **Implemented**: updates are never installed by the app; switching a model off never uninstalls |
| SEC-07 | Capability evaluations run isolated, least permissions, test data | MUST | checks | Post-V1 | **Partial**: the free tests run on test data; isolation for untrusted code is **Planned** |
| SEC-08 | The build agent runs in a sandbox: its own empty home folder, no git login, no push | MUST | engine + models | V1 | **Implemented** (#50). Windows untested |
| SEC-09 | Every build tool call is checked before it runs, by a hook and by `canUseTool`, inside the feature's own copy (words, then real paths with links followed), then by the gatekeeper | MUST | engine + gatekeeper | V1 | **Implemented** (#51). The real-path check covers file paths, not shell commands |
| SEC-10 | Shell commands are checked by enforced ask/never rules, and by an allow-list of known programs | MUST | gatekeeper | V1 | **Partial**: the 14 rules are enforced (Q-2, #54); the allow-list is in log-only mode (`SHELL_ALLOW_LIST_ENFORCED = false`) until joshua flips it after 3 real builds |
| SEC-11 | Installs for tests never run packages' own scripts; a package a build adds needs joshua's OK before Keep | MUST | checks | V1 | **Implemented** (#52, #53) |
| SEC-12 | Only the model's own failures count towards switching it off (Q-3) | MUST | engine + models | V1 | **Implemented** (#56) |

**Approved engine actions** (done by the engine itself, outside the Gatekeeper, by design):

1. Data-repo commit and push after tasks (F3): never forced, key-shaped text refused.
2. GitHub issues for phone messages (fine-grained token, Issues on the data repo only).
3. `pnpm outdated` look-ups (CI-6): only package names go to the registry; nothing is installed.
4. Package installs with `--ignore-scripts` for tests.
5. The live dev server and the picture server, on 127.0.0.1 only.

## 10. Evidence and audit requirements

| ID | Requirement | Priority | Release |
| --- | --- | --- | --- |
| EVD-01 | Every evidence record names its source (trial file, run, evaluation), date and, where known, version | MUST | V1 for trials and runs (**Implemented**; failed builds **Implemented** in #57) |
| EVD-02 | joshua's rating is stored apart from measured results | MUST | V1 (**Implemented**) |
| EVD-03 | Settings and data-file changes keep exact before/after (built: `changes` table). Every app edit to `habits.md` is recorded there, can be undone, and joshua is told (D-3 Option A). The app doesn't write `rules.md` yet; when it does, the same applies | MUST | V1 (**Implemented**) |
| EVD-04 | Only non-secret Markdown syncs to `ai-prototype-data` | MUST | V1 |
| EVD-05 | Tool status changes, approvals, new outside services and deletes are recorded | SHOULD | V1 where the step builds them, else Post-V1 (**Partial**: Allow once / No answers and new-package approvals are in History; other kinds aren't) |
| EVD-06 | Capability evaluations link capability, version, environment, run, evidence and date | SHOULD | Post-V1 (**Implemented** for the free tests: version and computer are saved with each result) |

## 11. Future screens (Post-V1)

| ID | Screen | Priority |
| --- | --- | --- |
| UI-01 | Capability Centre: registry, evaluations, comparisons, compatibility, recommendations, lifecycle | COULD (**Implemented**, #48; real records only; no real-use record) |
| UI-02 | "Why this was picked" view for a run | SHOULD (**Missing**; the Using line and workflow advice show part of it) |
| UI-03 | Correct a card, override a non-security suggestion, reject a proposed rule or habit | SHOULD (**Partial**: Undo of a habit change exists in History; no screen to reject one beforehand) |

All: Owner desktop (shows), engine/memory (data) · Depends: CAP-01..06 · Done when every number on screen has a real source and an honest "unavailable" state. The Tools page stays the day-to-day view.

## 12. Release priorities

1. **V1 steps 7 to 11:** built. Open: the real-use evidence for every step of V1-11, and the Linux check. CI-green is not available until Actions runs again.
2. **Phase 1 (next):** run records (build ID, every build including failed ones, causes), findings (one shape for check results, with trust levels), project map (feature, files, tests). See §14.
3. **Then:** CAP-04 (confidence and freshness), CAP-01 profile fields, cost per successful task (needs run records), the rest of CAP-02/CAP-03 and EVAL kinds.
4. **Later:** CAP-05/CAP-06 beyond workflows, UI-02, UI-03, SUP-A conflict tests, SUP-B wider review, narrow self-maintenance (Q-5, Phase 3).

## 13. Success measures

**V1:** one real Club HR feature done end to end (F-01 passed on 12 Nov; the rest is open); test results never hidden; every run names its model and tools; cost recorded where the provider gives it; Keep/Undo and rating saved; undo works; data repo syncs with no keys; Windows checked, Linux when possible.

**After V1:** recommendations raise success or cut cost without lowering quality; stale or incompatible versions are caught before they cause trouble; joshua can see and challenge why something was picked. Targets are set from measured starting points; none is claimed yet.

**Tests today (12 Nov, `99ac216`):** 605 TypeScript tests in 68 files passed (after `pnpm typecheck` builds the packages), plus 22 Rust tests (counted, not run here).

## 14. Decisions and next

**Decisions (joshua):**

- **D-1 (11 Nov):** EGM is "ON for big builds".
- **D-2 (11 Nov):** the stale rule, tool health, 3-failures switch-off and habit learning are spread over steps 1, 5, 8 and 9. In code now.
- **D-3 (11 Nov):** the protect-rules guard lives in `packages/gatekeeper`. Done. `rules.md` isn't guarded (Option A).
- **D-4 (11 Nov):** docs PRs are separate from code PRs.
- **Q-2 (12 Nov):** shell rules in the gatekeeper; the allow-list is log-only until joshua flips it. Done in #54.
- **Q-3 (12 Nov):** only the model's own failures count towards the 3-failure switch-off. Done in #56.
- **Q-4 (12 Nov):** approved. New packages need joshua's OK before Keep; changed versions don't block. Built in #53.
- **Q-5 (12 Nov):** narrow self-maintenance. Approved for later (Phase 3). Nothing is built.

**Next (the roadmap's Phase 1):**

1. **Run records:** a build ID, a record for every build including failed ones, and the cause of each failure.
2. **Findings:** one shape for check results, with trust levels.
3. **Project map:** feature to files to tests.

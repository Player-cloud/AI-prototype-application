# AI-prototype-application: product requirements

**Status:** working PRD, 2026-11-11. Built from joshua's draft and checked against the code at `c2b3fcf`.
**Authority:** the Claude Doc "AI-prototype-application: full plan" (10 Nov 2026). If this file disagrees with it, the plan wins.
**Related:** [System architecture](SYSTEM_ARCHITECTURE.md) · [Current-state audit](CURRENT_STATE_AUDIT.md)

**Words used:**

- **MUST** = required for its release.
- **SHOULD** = expected unless there's a good reason, written down.
- **COULD** = nice to have.

Releases: **V1** (the eleven steps) and **Post-V1**. No Post-V1 requirement is needed for V1 to be accepted.

Each requirement lists: priority, owner, depends on, release, status (from the [audit](CURRENT_STATE_AUDIT.md)), what it is, and how we know it's done.

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

P-05 and P-07 had no named build step in the plan. joshua decided on 2026-11-11 (D-2) to spread them over steps 1, 5, 8 and 9 ([audit §6](CURRENT_STATE_AUDIT.md#6-decisions-for-joshua)). `rules.md` stays above `habits.md`, except below 30% of the budget (P-03).

## 4. V1 scope: the eleven steps (unchanged)

One pull request per step (steps may be split into smaller PRs, as steps 3–6 were). Each step passes its tests on Windows and Linux before the next starts.

### V1-01 Tool trials (cloud)
- MUST · Owner: memory (records) · Depends: none · V1 · **Verified complete** (EGM ledger line still to fix per D-1; stale rule written but not applied in code)
- Token savers first, including Only CLI; then code quality, testing and website helpers; EGM tried for planning; 1–3 runs per job; account tools (Vercel, Figma) skipped. Results go into the first ledger and tool cards.
- Done when: every trialled tool has a ledger line and card with job, evidence, cost and status; untested tools say "NOT TESTED".
- Also (D-2): trial results are each tool's baseline. When a tool updates, the old results are marked stale and a re-test is due on next use.

### V1-02 Repo setup
- MUST · Owner: repo · Depends: none · V1 · **Verified complete**
- The monorepo, a short `CLAUDE.md`, and automatic checks on Windows and Linux.
- Done when: CI runs typecheck, tests and secret scan on both systems and passes.

### V1-03 Window and screens
- MUST · Owner: apps/desktop · Depends: V1-02 · V1 · **Verified complete**
- The Tauri shell, a React skeleton, the engine helper starting up, and Settings with the encrypted key.
- Done when: the window opens on Windows and Linux, shows the engine running, and saves a key to the OS password store without ever showing it again.

### V1-04 Model adapter
- MUST · Owner: models · Depends: V1-03 · V1 · **Verified** for Claude; **unverified** for OpenAI/DeepSeek with real keys
- Claude through the Agent SDK first, with OpenAI and DeepSeek adapters behind the same setting.
- Done when: one setting switches provider; each adapter reports tokens and cost (or "cost unknown"); Claude-only extras that don't carry over are tracked per model in the ledger.

### V1-05 Memory and data repo
- MUST · Owner: memory (+ engine for the Using line) · Depends: V1-04 · V1 · **Implemented but unverified**; Using line and sync-after-task wait for a task loop
- The three files, tool cards, memory-graph links, the Using line, and automatic sync after each task.
- Done when: the engine reads summaries first; ledger/habits/rules/cards load from the data folder; the Using line shows before each run; the data repo syncs after each task without forcing and without keys; cost and undo history are in local SQLite.
- Also (D-2): tool health, failure history, stale evidence, re-test results and habits are saved, with tool cards and data repo records updated. *Not built yet: needs a follow-up PR.*

### V1-06 Gatekeeper and undo
- MUST · Owner: gatekeeper (rules) + engine (applies them) + memory (history) · Depends: V1-05 · V1 · **Implemented but unverified**; not yet in the path of agent actions
- The ask-first rules, plus one-click undo for files, settings and tools.
- Done when: every risky agent step is checked before it runs; the agent can't edit the rules or settings; settings, data files, project files (via worktree) and tool changes can be undone in one click, and undo refuses safely if things changed since.

### V1-07 Plan interview
- MUST · Owner: engine (flow) + desktop (screen) + memory (spec storage) · Depends: V1-06 · V1 · **Not started**
- The stage-by-stage questions, ending in a spec with IDs and done files. Stages: idea; who it's for and goals; features; enterprise checklist areas; look and brand; tech (standard stack unless told otherwise); what "done" means. All of a stage's questions in one message, related tools listed first, no moving on until joshua confirms. Planning trialled with EGM.
- Done when: a finished interview writes `projects/<name>/spec.md` with feature IDs and one pass/fail done file per feature; big plans (P-11 below) get the fresh-eyes review.

### V1-08 Build loop
- MUST · Owner: engine · Depends: V1-07 · V1 · **Not started**
- One feature per run in a worktree, a live step list, and 2 fix attempts.
- Done when: each run uses its own git worktree; one feature per run; the live step list updates; after 2 failed fix attempts the run stops and says so; every agent tool call passes the gate.
- Also (D-2): a tool that fails 3 times in a row is switched off, joshua is told, and the engine won't pick it until he chooses retry, re-enable or uninstall. Switching off never uninstalls.

### V1-09 Check, preview and report
- MUST · Owner: checks + engine + desktop + memory · Depends: V1-08 · V1 · **Not started** (Keep rule and big-build rule exist)
- Tests, free checks, checklist rules, pictures, the report in £ and $, Keep or Undo, and the rating.
- Done when: tests must pass for Keep; free checks run every build; desktop and phone pictures every build, looked at by a model only when screens changed; the report shows changes, tests, cost in £ and $ and pictures; Keep/Undo and a 1–5 rating are recorded; paid and fresh-eyes reviews only on big builds.
- Also (D-2): after Keep/Undo and the rating, the app looks for repeated preferences, updates `habits.md` only when there's enough evidence, and tells joshua what it added or changed.

### V1-10 Phone messages
- MUST · Owner: engine (+ desktop panel) · Depends: V1-09 · V1 · **Not started**
- GitHub updates, work items, and a panel of items that need joshua.
- Done when: the app posts to GitHub when a task finishes or needs him; he can answer and press Keep or Undo from his phone; the panel lists only items needing him.

### V1-11 First real run
- MUST · Owner: all · Depends: V1-10 · V1 · **Not started**
- One Club HR feature end to end on joshua's Windows PC, then a Linux check once he has the machine.
- Done when: one real feature goes through all eight task steps with real evidence for each.

### Rules that apply across V1

| ID | Rule | Owner |
| --- | --- | --- |
| P-11 | Fresh-eyes and paid reviews only on big builds: 5+ features, or logins, payments or personal data. Full enterprise checklist once before an app is called done. | checks (`isBigBuild`) |
| P-12 | Standard stack: Next.js + TypeScript, Postgres on Neon, Auth.js, shadcn/ui with Sonner, Vaul and cmdk, unless a project says otherwise. | templates/web-app |
| P-13 | Model per job: Opus plans, final and security review; Sonnet builds and reviews plans; Haiku reads, summarises, writes tests, reviews code (Sonnet for security or multi-file). | models (defaults), engine (choice) |

### V1 acceptance

V1 is done when V1-11 passes: one real Club HR feature through planning, choice of model and tools, worktree build, required checks, pictures, £/$ report, Keep/Undo, rating and data sync, on Windows, with the Linux check done when a machine is available. Screens or packages existing don't count on their own.

### Not in V1

- A Capability Centre screen or dashboard.
- 0–100 scores, benchmark suites, automatic comparisons or A/B routing.
- Installing, updating, disabling or removing plugins, skills or mods automatically.
- Update watching.
- Self-changes beyond the small-change rule; any change to gatekeeper rules by the app.
- Agent teams beyond what the build loop needs.
- Deploy and client handover.
- Phone actions beyond V1-10.

## 5. Capability Intelligence requirements

Capability Intelligence = the app's evidence about what it can use (models, tools, plugins, skills, mods and extensions, agents, workflows), used to advise the engine. Owners are existing packages ([architecture §12](SYSTEM_ARCHITECTURE.md#12-capability-intelligence)). It never chooses, runs or approves anything itself.

### 5.1 V1 foundations (already inside V1 steps; nothing new)

#### CAP-V1-01 Trial records
- MUST · Owner: memory · Depends: V1-01 · V1 · Built
- Each trial is recorded with job, runs, result, cost, issues and recommendation in the ledger and cards.
- Done when: failed, skipped and passed trials are distinguishable; unknown numbers stay unknown; trials are marked as screening (1–3 runs), not benchmarks.

#### CAP-V1-02 Cards and summaries
- MUST · Owner: tools (format) + memory (storage) · Depends: V1-05 · V1 · Built
- One card per tool (What, Use when, Don't use when, Cost) and a one-line summary for choosing.
- Done when: the engine chooses from summaries without opening every card; `tools/<name>.md` stays the one card store.

#### CAP-V1-03 Record what was actually used
- MUST · Owner: engine · Depends: V1-08 · V1 · Not started (`usingLine()` exists, unused)
- The `Using:` line shows the model and tools actually picked, for every run.
- Done when: the line matches what ran; tools not picked don't start.

#### CAP-V1-04 Link use to outcome
- MUST · Owner: memory (record) + engine (writes it) · Depends: V1-09 · V1 · Not started
- Each run's model, tools, tokens, cost, test result, Keep/Undo and rating are linked. **Proposed:** a task-run table in the existing `history.sqlite`, linked to its `spend` rows.
- Done when: the app can say which model and tools a run used and how it went; test results and joshua's rating are stored separately.

#### CAP-V1-05 Stale evidence and 3-failures rule
- MUST (plan principles P-05, P-07) · Owner: engine (enforces failures, skips switched-off tools) + tools (health, version/config changes) + memory (records, stale evidence, habits) · Depends: V1-01, V1-05, V1-08, V1-09 · V1 (split per D-2) · Not started
- When a known tool or model version changes, old results are tagged stale and it's re-tested on next use (step 1 baseline, step 5 records). 3 failures in a row → tell joshua, switch off, don't pick it until he decides (step 8). Habits are learnt after Keep/Undo and rating (step 9).
- Done when: stale results show as stale; switched-off tools show as OFF with the reason and are never picked; nothing is uninstalled without joshua; each habit change is reported to him.

### 5.2 After V1

#### CAP-01 Versioned capability profiles
- SHOULD · Owner: memory · Depends: CAP-V1-02 · Post-V1
- One profile per capability (stable name = card file name) and per version: kind, source, purpose, needs, permissions, data access, cost, status, evidence, workflows that use it.
- Done when: unknown source, version or install scope shows as "unknown"; cards and ledger are extended, not copied.

#### CAP-02 Evaluations by kind
- SHOULD · Owner: checks (runs) + memory (stores) · Depends: CAP-01 · Post-V1
- Repeatable tests suited to each kind (see §6).
- Done when: each suite states its aim, inputs, expected result, environment, permissions and pass rule; runs use checks' runners and test data; results are passed / failed / skipped / blocked / not run, with evidence links.

#### CAP-03 Separate measures
- SHOULD · Owner: memory (stores) + engine (reads) · Depends: CAP-02 · Post-V1
- Capability quality, task suitability, trust and security, cost efficiency, user satisfaction and evidence confidence, kept apart.
- Done when: an optional 0–100 score uses published weights per kind; per-measure results and run counts stay visible; untested isn't 0; a security, permission, compatibility or required-test failure can't be outweighed; joshua's rating isn't mixed into automatic scores.

#### CAP-04 Confidence and freshness
- SHOULD · Owner: memory · Depends: CAP-02 · Post-V1
- Done when: run count, date, environment and version show with every result; small samples are labelled screening; new versions are tested, not given old scores.

#### CAP-05 Comparisons
- COULD · Owner: checks + memory · Depends: CAP-03 · Post-V1
- Done when: candidates use the same inputs and environment; failures of hard gates make a candidate ineligible, not a loser; sample size and doubt are shown.

#### CAP-06 Recommendations
- SHOULD · Owner: engine (decides) using memory evidence · Depends: CAP-03 · Post-V1
- Done when: each recommendation explains fit, evidence age, quality and cost; it respects budget, compatibility and gatekeeper; it never installs or switches on anything; the engine still makes the final choice.

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

All SHOULD · Owner: checks (runs) + memory (stores) · Depends: CAP-02 · Post-V1. Done when: each kind has its own rubric; scores from different kinds are not compared as if alike.

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

## 8. Non-functional requirements

| ID | Requirement | Priority | Release |
| --- | --- | --- | --- |
| NFR-01 | Works on Windows and Linux; CI on both; platform differences (paths, shells, keyring) handled explicitly | MUST | V1 |
| NFR-02 | Token-light: summaries first, tools loaded only when picked, no idle agents | MUST | V1 |
| NFR-03 | Failures reported honestly; retries limited (2 fix attempts); work isolated per worktree | MUST | V1 |
| NFR-04 | Enough records to explain choices, costs, failures and changes, without keys or unneeded private code | MUST | V1 |
| NFR-05 | Small packages with one job each; swappable adapters; no parallel stores | MUST | V1 |
| NFR-06 | Status words are exact: passed, failed, skipped, blocked, not run, stale, unknown | MUST | V1 |
| NFR-07 | Untrusted capability code never runs inside the main app process | MUST | Post-V1 (no such code runs in V1) |

## 9. Security and privacy requirements

| ID | Requirement | Priority | Owner | Release |
| --- | --- | --- | --- | --- |
| SEC-01 | Keys only in the OS password store via Settings; never in chat, Markdown, GitHub, logs, prompts or pictures | MUST | desktop + models | V1 (built) |
| SEC-02 | Ask first before spending money or sending code or data to a new outside service | MUST | gatekeeper | V1 (built as rules; wired in step 8) |
| SEC-03 | The agent can never edit or get around gatekeeper rules or settings; rule changes only through Settings with joshua's approval | MUST | gatekeeper (guard moves in per D-3) | V1 (built in engine; move pending) |
| SEC-04 | Data repo sync refuses key-shaped text and never forces | MUST | memory | V1 (built) |
| SEC-05 | Claude runs with an allow-listed environment and its own config folder | MUST | models | V1 (built) |
| SEC-06 | Nothing is installed, enabled, disabled or removed because of a score | MUST | engine | all releases |
| SEC-07 | Capability evaluations run isolated, least permissions, test data | MUST | checks | Post-V1 |

## 10. Evidence and audit requirements

| ID | Requirement | Priority | Release |
| --- | --- | --- | --- |
| EVD-01 | Every evidence record names its source (trial file, run, CI run), date and, where known, version | MUST | V1 for trials and runs |
| EVD-02 | joshua's rating is stored apart from measured results | MUST | V1 |
| EVD-03 | Settings and data-file changes keep exact before/after (built: `changes` table). Every app edit to `rules.md` or `habits.md` is recorded there, can be undone, and joshua is told (D-3 Option A) | MUST | V1 |
| EVD-04 | Only non-secret Markdown syncs to `ai-prototype-data` | MUST | V1 |
| EVD-05 | Tool status changes, approvals, new outside services and deletes are recorded | SHOULD | V1 where the step builds them, else Post-V1 |
| EVD-06 | Capability evaluations link capability, version, environment, run, evidence and date | SHOULD | Post-V1 |

## 11. Future screens (Post-V1)

| ID | Screen | Priority |
| --- | --- | --- |
| UI-01 | Capability Centre: registry, evaluations, comparisons, compatibility, recommendations, lifecycle | COULD |
| UI-02 | "Why this was picked" view for a run | SHOULD |
| UI-03 | Correct a card, override a non-security suggestion, reject a proposed rule or habit | SHOULD |

All: Owner desktop (shows), engine/memory (data) · Depends: CAP-01..06 · Done when every number on screen has a real source and an honest "unavailable" state. The Tools page stays the V1 view.

## 12. Release priorities

1. **V1:** V1-07 → V1-11 in order, plus CAP-V1-03, CAP-V1-04 inside steps 8–9, and CAP-V1-05 split over steps 1, 5, 8 and 9 (D-2). Steps 1 and 5 parts need follow-up PRs.
2. **First after V1:** CAP-01, CAP-04, SUP-E, SUP-F (tidy foundations, versions, stale handling, cost per task).
3. **Then:** CAP-02, CAP-03, EVAL-01..07, SUP-A, SUP-B.
4. **Then:** CAP-05, CAP-06, SUP-C, SUP-D, UI-02, UI-03.
5. **Later:** SUP-G, SUP-H extensions, SUP-I, UI-01, update watching.

## 13. Success measures

**V1:** one real Club HR feature done end to end; test results never hidden; every run names its model and tools; cost recorded where the provider gives it; Keep/Undo and rating saved; undo works; data repo syncs with no keys; Windows checked, Linux when possible.

**After V1:** recommendations raise success or cut cost without lowering quality; stale or incompatible versions are caught before they cause trouble; joshua can see and challenge why something was picked. Targets are set from measured starting points; none is claimed yet.

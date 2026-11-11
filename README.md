# AI-prototype-application

A desktop app (Windows and Linux) where you describe a web app, it plans it with you stage by stage, builds it one feature at a time, checks it, and you press Keep or Undo.

## Layout

| Folder | What it is |
| --- | --- |
| `apps/desktop` | Tauri window + React screens (see its README to run it) |
| `packages/engine` | Agent loop, Using line, money in £ and $ |
| `packages/models` | Claude, OpenAI, DeepSeek adapters; model per job |
| `packages/tools` | Tool runners and tool cards |
| `packages/memory` | Summaries first, memory-graph links, data repo sync |
| `packages/checks` | Tests, free checks, Keep rules |
| `packages/gatekeeper` | Ask-first rules (agents can't edit) |
| `templates/web-app` | Standard stack starter for new websites |

## Ask-first rules

Every risky step goes through the engine's `gate`, which asks `packages/gatekeeper`. The gatekeeper is the one authority: its guard always runs first, so the agent can never change the gatekeeper package or the app's settings, even with an OK. Then come its ask-first rules, then your own from Settings → Ask-first rules (words to watch for, and why). The app may update `rules.md` itself and tell you, with history and undo. Only you can add or remove your own rules.

## Plan interview

Projects → name a project → answer seven stages in order: the idea, who it's for and goals, features, enterprise checklist areas, look and brand, tech, and what "done" means. Each stage shows its questions together, with related tools from your ledger listed first, and nothing moves on until you confirm. Answers save to `projects/<name>/interview.json` in your data repo. Confirming the last stage writes `spec.md` (every feature gets a fixed ID like F-01) and one pass/fail file per feature in `done/`, then syncs the data repo. No model is called unless you ask.

Each stage also has **Ask Claude for ideas**. It sends the answers so far to the planning model (Opus for Claude) and shows suggested questions, checklist areas, features or done checks. The button shows the most it can cost first, and the real cost after; it counts against your monthly budget. Nothing is added to the plan until you pick it.

When the interview is finished, **Review the plan** checks it. Small plans get one review by the plan-review model (Sonnet for Claude). Big plans (5+ features, or logins, payments or personal data) get three fresh-eyes reviewers instead: one looks at users and goals, one at features and done checks, one at risk. Each sees only `spec.md` and the done files, not how the plan was made. Findings (must fix, should fix, could add) are saved as `projects/<name>/review.md` and synced. The button shows the most it can cost first. If you change the plan, the review is marked out of date. Nothing in the plan changes until you edit it.

## Feature builds (step 8)

Each finished project has a **Code folder** box: where its repo is cloned on this computer (saved per computer in settings.json). Every feature build runs in its own git worktree next to it, `<folder>-runs/F-01-<time>`, on a new branch `aip/f-01-<time>`, starting from the folder's last commit. Your own copy is never touched; uncommitted changes there aren't included. Keep or Undo comes in step 9.

A build run (engine `build_feature`) gives the build model (Sonnet for Claude) the spec and the feature's done file, and lets it read, edit and run commands only in that copy. Every tool call is checked first: paths must stay inside the copy, then the gatekeeper decides. Anything that needs your OK (push, deploy, outside services) is refused and noted, and key files are never touched. The Using line shows first, for example "Using: Sonnet 5.5, file edits, shell, tests". A run stops at its cost limit, £0.80 by default (Settings → Budget and models), or at what's left of the month's budget. Building needs Claude for now.

The **Build** screen lists finished plans and their features. Press **Build F-01** (it shows the most it can cost first) to watch the Using line and each step as it happens; refused steps show why. **Stop** ends the run. Each build runs in its own engine helper, so the rest of the app stays quick, and only one build runs at a time.

After the model finishes, the project's own tests run in the copy (`pnpm test`, or the package manager its lock file shows; packages are installed first if the copy has none). If they fail, the model gets up to 2 fix attempts with the end of the test output, inside what's left of the run's limit. It's told never to skip, delete or weaken tests. The result shows whether the tests pass and the end of their output; a build whose tests fail can't be kept. The data folder syncs after each build.

## Free checks (step 9)

After the tests, three free checks run in the build's copy (no model, no cost):

- **Secret scan:** secretlint (the same rules as this repo's `pnpm secrets`) on every file the build added or changed, plus no key files (.env, *.pem). Secret values are never shown. A failure stops Keep.
- **Package audit:** `pnpm audit` (or `npm audit`). High or critical problems stop Keep. If it can't run, for example with no internet, that's shown as advice.
- **Checklist rules:** simple rules for the enterprise checklist areas the project ticked, checked on the lines the build added. Examples: images need alt text, no raw HTML, no passwords in logs, no fixed widths too wide for a phone. These are advice: they're shown but don't stop Keep.

## Keep or Undo (step 9)

Every build is saved on this computer (in history.sqlite, next to the spend records) and listed under **Builds** on the Build screen, so a build can be decided later, even after the app restarts.

- **Keep** merges the build's branch into your copy, on the branch you have checked out, as one merge commit. It never pushes. It's refused when the build's tests fail or your copy has changes not committed yet, and if the build clashes with your newer work nothing is changed. The build's copy and branch are then removed.
- **Undo** removes the build's copy and branch. Your copy isn't touched.
- Each build can be rated 1–5. Ratings are the evidence the app learns from later in step 9.

## Tool health

Each tool has a small health record in the data repo, `tool-health/<tool>.json`: the version in use, the version its test evidence is for, and its recent failures. When a tool updates, its old evidence is marked stale and it gets a quick retest the next time it's used. A good run clears the mark. The Tools page shows this under each tool, for example "2 failures in a row." Each build model run counts as a use of that model (for example "Sonnet 5.5"); a Stop doesn't count. After 3 failures in a row the model is switched off, you're told, and builds refuse it until you press **Switch … back on** on the Tools page (it's then retested on its next use). Switching a tool off never uninstalls it.

## Undo

Every settings change and tool rating is kept in `history.sqlite` on this computer, with exactly what it was before and after. Settings → Change history lists them, each with an Undo button. Undo only puts a change back if nothing has changed it since; otherwise it says so and touches nothing. Undoing a rating also syncs the data repo. An undo can itself be undone (shown as Redo).

Private data (ledger, habits, rules, tool cards, tool health, project plans) lives in the separate `ai-prototype-data` repo.

## Commands

```
corepack pnpm install
corepack pnpm check
```

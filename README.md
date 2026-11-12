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

No repo yet? Type a new or empty folder and press **Make a new one here**. The app makes an empty git repo there on branch `main`, with a README, a `.gitignore` that keeps keys out (`.env`, `*.pem`), and one first commit, then saves it as the project's code folder. It never touches a folder that already has something in it, and nothing is pushed. Git needs your name and email set once (`git config --global user.name` / `user.email`); if they're missing, the app says so.

A build run (engine `build_feature`) gives the build model (Sonnet for Claude) the spec and the feature's done file, and lets it read, edit and run commands only in that copy. Every tool call is checked first: paths must stay inside the copy, then the gatekeeper decides. Anything that needs your OK (push, deploy, outside services) is refused and noted, and key files are never touched. The Using line shows first, for example "Using: Sonnet 5.5, file edits, shell, tests". A run stops at its cost limit, £0.80 by default (Settings → Budget and models), or at what's left of the month's budget. Building needs Claude for now.

The **Build** screen lists finished plans and their features. Press **Build F-01** (it shows the most it can cost first) to watch the Using line and each step as it happens; refused steps show why. **Stop** ends the run. Each build runs in its own engine helper, so the rest of the app stays quick, and only one build runs at a time.

After the model finishes, the project's own tests run in the copy (`pnpm test`, or the package manager its lock file shows; packages are installed first if the copy has none). If they fail, the model gets up to 2 fix attempts with the end of the test output, inside what's left of the run's limit. It's told never to skip, delete or weaken tests. The result shows whether the tests pass and the end of their output; a build whose tests fail can't be kept. The data folder syncs after each build.

## Live view (V2)

While the model works, the Build screen shows the build's own page live, at desktop and phone sizes, so you can watch it take shape. The app starts the page in the build's copy as soon as there is one to show (`next dev` or `vite` once its packages are installed, or a plain `index.html`), only on this computer (127.0.0.1), and starts it again if it stops (5 tries at most). Next.js and Vite update the page themselves; a plain page is reloaded as the build changes it. The model is told not to start its own dev server. The live view closes when the model is done, before the free checks and the final pictures, and always when a build fails or is stopped. It costs nothing.

## Honest build report (V2)

The build report keeps the model's own summary apart from what the app checked. The summary is shown as "What the model says it did", in its own words. Under it, each thing the summary claims (tests, audit, secrets, accessibility, phone width, type check, lint, production build) is set beside what the app found itself: ✓ the app's own check agrees, ✗ it disagrees, ? the app didn't check it (or its check didn't run), so only the model says so. The phone message shows the same lines.

## Free checks (step 9)

After the tests, three free checks run in the build's copy (no model, no cost):

- **Secret scan:** secretlint (the same rules as this repo's `pnpm secrets`) on every file the build added or changed, plus no key files (.env, *.pem). Secret values are never shown. A failure stops Keep.
- **Package audit:** `pnpm audit` (or `npm audit`). High or critical problems stop Keep. If it can't run, for example with no internet, that's shown as advice.
- **Checklist rules:** simple rules for the enterprise checklist areas the project ticked, checked on the lines the build added. Examples: images need alt text, no raw HTML, no passwords in logs, no fixed widths too wide for a phone. These are advice: they're shown but don't stop Keep.

## Pictures (step 9)

After the free checks, the app takes a desktop picture (1280×800) and a phone picture (390×844) of the build's home page. It uses the browser already on the computer: Edge on Windows, Chrome on Linux, or the browser whose full path is in `AIP_BROWSER`. Nothing is downloaded. It starts the page with `next dev` or `vite` when the project uses them, or serves a plain `index.html`. The pictures are saved next to the build's copy (`…-runs/F-01-<time>-pictures`), never inside it, and compared with the last build's so the report says whether the screens changed.

Two more free checks come with the pictures, both advice only:
- **Accessibility:** axe, which lists serious and critical problems.
- **Phone width:** whether the page fits a phone's width without scrolling sideways.

If the page can't start or the browser can't open, the report says why and the build carries on.

## Keep or Undo (step 9)

Every build is saved on this computer (in history.sqlite, next to the spend records) and listed under **Builds** on the Build screen, so a build can be decided later, even after the app restarts.

- **Keep** merges the build's branch into your copy, on the branch you have checked out, as one merge commit. It never pushes. It's refused when the build's tests fail or your copy has changes not committed yet, and if the build clashes with your newer work nothing is changed. The build's copy and branch are then removed.
- **Undo** removes the build's copy and branch. Your copy isn't touched.
- Each build can be rated 1–5. Ratings are the evidence the app learns from (below).

## What the app learns (step 9)

After each Keep, Undo or rating, the app looks at its build history and keeps its own section of `habits.md` ("Learned by the app") up to date. Your own lines above it are never changed. It only writes a habit when there's enough evidence:

- A build model with at least 5 decided builds: "usually kept" (80% or more kept, and an average rating of 4 or more once there are 3 ratings) or "often undone or rated low" (40% or less kept, or an average of 2.5 or less).
- A checklist rule tripped in at least 3 of the last 10 builds.
- Fix attempts needed in at least 3 of the last 5 builds.

A habit is updated when the numbers change, and dropped when it stops being true. Each change is shown on the Build screen, kept in **History** (one-click undo) and synced to the data repo. Every build is given your rules and habits; your rules win while more than 30% of the month's budget is left, and below that a cheaper habit wins where the two clash.

## Phone messages (step 10)

The app messages your phone through GitHub Issues on your private data repo (the one your data folder is cloned from). The GitHub app on your phone shows them as notifications.

To set it up, make a **fine-grained** token on GitHub (Settings → Developer settings → Fine-grained tokens). Give it access to the data repo only, with **Issues: Read and write** and nothing else. Paste it into Settings → API keys → GitHub, then press **Test connection** (free: it only reads issues). The token is kept in the computer's password store like the model keys, and only ever sent to GitHub.

When a build finishes it needs you (Keep or Undo), so it shows under **Needs you** at the top of the Build screen and, with a token saved, is posted as an issue with the tests, checks, cost in £ and $, and the build's summary. When you Keep or Undo it on the PC, the issue gets a short reply and is closed. A GitHub problem never stops a build or a Keep; the app just says the message didn't go.

You can answer from your phone: reply on the issue with **keep**, **undo**, or a rating from **1** to **5** (only the first line counts). While the app is open it reads replies about once a minute (or press **Check phone replies now**), does the same as the buttons on the PC, and answers on the issue. Keep from the phone has the same rules: it's refused if the tests or a blocking check failed, or your copy has changes not committed yet, and the reply says why. Only people with access to the private data repo count, and the app never reads its own posts as yours.

## Tool health

Each tool has a stable ID: its card's file name in `tools/` (for example `haiku`), or its ledger name as a slug when it has no card. Cards are matched to ledger lines by best fit, the same whatever the line order; a card can also name its line exactly with `Ledger: <name>`, and say `Kind:` (model, tool, plugin, skill, mod, agent or workflow) and `Version:`. Anything not written shows as unknown on the Tools page.

Each tool has a small health record in the data repo, `tool-health/<id>.json`: the version in use, the version its test evidence is for, and its recent failures. The app notes the versions in use on every build: the build model's ID, and the installed versions of secretlint, axe-core and Playwright. When a tool updates, its old evidence is marked stale and it gets a quick retest the next time it's used; for the check tools that's the same build, and the step list says so. A good run clears the mark. The Tools page shows this under each tool, for example "2 failures in a row." Each build model run counts as a use of that model (for example "Sonnet 5.5"); a Stop doesn't count. After 3 failures in a row the model is switched off, you're told, and builds refuse it until you press **Switch … back on** on the Tools page (it's then retested on its next use). Switching a tool off never uninstalls it.

## Computers (Capability Intelligence)

joshua uses two computers, so tool versions are tracked per computer: a different version on the laptop never marks the PC's evidence out of date. The Tools page shows each tool's version on each computer when they differ.

**Check this computer** (Tools page, free, changes nothing) looks at Node (the app needs 22 or newer), pnpm against the pinned version, git and whether its name for commits is set, Edge or Chrome for the pictures, and the check tools (secretlint, axe-core, Playwright). It also notes the Claude Agent SDK's version. The result is saved as `environments/<computer>.json` in the data repo and synced, so each computer shows the other's last check and the versions that differ between them.

The Tools page also lists duplicate or clashing tools in the ledger: two lines with the same ID, two tools both on for the same job (a BACKUP is fine), or a card whose `Ledger:` line names a line that isn't there. This is advice only; nothing is switched on or off because of it.

## Repeatable tests (Capability Intelligence)

Settings → Tools → **Run free tests** checks that each check tool still does its job, using planted problems on test data (nothing private is used or sent anywhere). Free: £0.00 ($0.00).

- secretlint must find a planted GitHub token and private key, flag a `.env` file, and stay quiet on a clean file.
- The checklist rules must each find their planted problem and raise nothing on clean lines.
- axe-core must find an image without alt text, an unlabelled box, a missing page language, and a page too wide for a phone.
- Playwright must take the desktop and phone pictures.

Results are passed, failed or "couldn’t run here" (no browser, say), never a made-up score. Each names the tool's version and the computer, and is saved in the data repo as `evaluations/<id>.json` (last 30). A pass on a new version clears the "retest due" mark; a fail counts as a failure in tool health; "couldn’t run here" counts as neither. Fewer than 3 runs is shown as a first look, not proof. A tool with no test stays "Untested". Paid model tests come later, and only with joshua's OK.

## Undo

Every settings change and tool rating is kept in `history.sqlite` on this computer, with exactly what it was before and after. Settings → Change history lists them, each with an Undo button. Undo only puts a change back if nothing has changed it since; otherwise it says so and touches nothing. Undoing a rating also syncs the data repo. An undo can itself be undone (shown as Redo).

Private data (ledger, habits, rules, tool cards, tool health, project plans) lives in the separate `ai-prototype-data` repo.

## Commands

```
corepack pnpm install
corepack pnpm check
```

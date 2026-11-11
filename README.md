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

## Tool health

Each tool has a small health record in the data repo, `tool-health/<tool>.json`: the version in use, the version its test evidence is for, and its recent failures. When a tool updates, its old evidence is marked stale and it gets a quick retest the next time it's used. A good run clears the mark. The Tools page shows this under each tool, for example "2 failures in a row." Switching a tool off never uninstalls it. What happens after repeated failures comes with the build loop (step 8).

## Undo

Every settings change and tool rating is kept in `history.sqlite` on this computer, with exactly what it was before and after. Settings → Change history lists them, each with an Undo button. Undo only puts a change back if nothing has changed it since; otherwise it says so and touches nothing. Undoing a rating also syncs the data repo. An undo can itself be undone (shown as Redo).

Private data (ledger, habits, rules, tool cards, tool health, project plans) lives in the separate `ai-prototype-data` repo.

## Commands

```
corepack pnpm install
corepack pnpm check
```

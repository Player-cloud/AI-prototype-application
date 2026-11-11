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

Every risky step goes through the engine's `gate`. It uses the rules in `packages/gatekeeper` unchanged, adds a guard so the agent can never edit those rules or the settings file, and adds your own rules from Settings → Ask-first rules (words to watch for, and why). Only you can add or remove your own rules.

Private data (ledger, habits, rules, tool cards, project plans) lives in the separate `ai-prototype-data` repo.

## Commands

```
corepack pnpm install
corepack pnpm check
```

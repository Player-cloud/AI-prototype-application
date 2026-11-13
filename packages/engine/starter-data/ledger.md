# Tool ledger

One line per tool: status | job | evidence | tokens/cost | your rating.

- Only CLI (oc) | ON, DEFAULT web reader | web reading | 41% fewer tokens, 59% cheaper than WebFetch, same answers (3 pages); PC: nextjs 1.2k vs 112k tok, Tauri 472 vs 40k; Stack Overflow 403 -> use WebFetch there | ~1-3k tok per lookup | rating: -
- WebFetch | BACKUP web reader | web reading when Only CLI fails | baseline in round 1 | - | rating: -
- Haiku 5.5 | ON | reading, summaries, small well-specified code | 5/5 facts, 14/14 tests | 1/15-1/30 of Sonnet/Opus cost | rating: -
- Sonnet 5.5 | ON | building real features until a harder trial says otherwise | 14/14 tests; needs harder trial | - | rating: -
- Opus 5.5 | ON | planning, final review | 5/5, 14/14; most expensive | - | rating: -
- Prompt caching | ON (always) | every model call | input cost 67% of uncached in short runs | - | rating: -
- Summaries-first memory | ON (always) | reading memory | ~93% fewer tokens than reading all files | - | rating: -
- EGM | TRIAL NEXT | planning | not run yet | - | rating: -
- Code review by Haiku | ON | review every change | 6/6 planted bugs, $0.0014 (round 2) | - | rating: -
- Plan review by Sonnet (one pass) | ON | review every plan | 10/10 planted gaps, $0.019 | - | rating: -
- EGM review | ON for big builds only, once per plan | fresh-eyes plan review | 10/10 + severity + verdict, $1.45, ~1M tokens | - | rating: -
- Opus single-pass plan review | NOT NEEDED (Sonnet as good, cheaper) | - | 9/10, $0.049 | - | rating: -
- Test writing by Haiku | ON | unit tests per feature | 9/9 planted bugs caught, $0.0035 (round 3) | - | rating: -
- axe-core + phone-overflow script | ON, always | page checks every build | 6/7 planted problems, $0, <1 s | - | rating: -
- Haiku page-code check | ON | catches what free checks miss | 7/7, $0.0013 | - | rating: -
- Playwright screenshots | ON (free) | pictures every build; model looks only when screens change | 5/7 from pictures; best for look and feel | - | rating: -
- secretlint | ON, always | secret scan every build | 4/6 planted, 0 false alarms, $0 (round 4) | - | rating: -
- Haiku secret check | ON | before every Keep | 6/6 planted, 0 false alarms, $0.0044 | - | rating: -
- npm audit | ON, always | risky packages every build | 3/3 vulnerable versions, $0 | - | rating: -
- Gatekeeper hook | ON, always | block push, bulk delete, key files, new services | 5/5 risky attempts blocked | - | rating: -
- Lazy tool loading | ON | engine design | all tools add ~30k tokens per call | - | rating: -
- Desktop Commander / Claude in Chrome / computer use | NOT TESTED (PC only) | PC and browser jobs | - | - | rating: -
- shadcn/ui + Sonner, Vaul (Drawer), cmdk (Command) | ON, standard stack | website UI | worked on a Windows laptop with pnpm 10 pinned: init 23s, add 6s, build 14s (PC trial) | - | rating: -
- pnpm 10 (pinned per project) | ON | package installs in the web-app template | npm 12 breaks create-next-app; pnpm 12 blocks packages <24h old (kept as safety rule) | - | rating: -

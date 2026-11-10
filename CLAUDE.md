# Rules for agents working on this repo

Owner: joshua (single user). Plan: "AI-prototype-application: full plan" (Claude Doc).

- Plain words, short replies. Show money in £ and $.
- One feature per pull request. Tests must always pass and are never skipped or cut.
- Run `pnpm check` before every push (typecheck, tests, secret scan).
- Never read, write or commit keys (.env, *.pem). Keys live only in the app's Settings.
- `packages/gatekeeper` holds the ask-first rules. Agents never edit it; only joshua changes it.
- Ask joshua first before anything that costs money, sends code or data to a new outside service, deploys, pushes to main, or deletes in bulk.
- Model per job: Opus plans and does final/security review; Sonnet builds and reviews plans; Haiku reads, summarises, writes tests and reviews code (Sonnet for security or multi-file changes).
- Tools load only when picked. Web reading: Only CLI first, WebFetch as backup.
- Package manager: pnpm 10 (pinned in package.json). Don't use npm 12 for Next.js apps.
- Must run on Windows and Linux (not macOS).

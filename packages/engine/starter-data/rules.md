# General tool rules

The app may change this file itself and says what it changed afterwards.

## Choosing
- One tool per job. Tools stay off until a task needs them; token savers may stay on.
- General rules win while more than 30% of the monthly budget is left; below that your preferences in habits.md win, and the app says so.
- A tool that fails 3 times in a row: tell you, switch it off, then decide together about removing it.
- When a tool updates: tag its old results as stale and re-test it on next use.

## Models
- Opus 5.5: planning, final review, security review.
- Sonnet 5.5: building real features; one-pass plan review on every plan; code review for security or multi-file changes.
- Haiku 5.5: reading, summaries, small clear code, writing tests, code review, page-code checks, secret check before Keep.

## Every build
- Tests must pass (never cut). Free checks always: axe, phone overflow, secretlint, npm audit.
- Pictures every build; a model looks only when screens changed.
- EGM fresh-eyes review only for big builds (5+ features, or logins, payments, personal data), once per plan.

## Web reading
- Only CLI first; WebFetch as backup (Stack Overflow blocks Only CLI).

## Ask you first
- Anything that costs money, sends code or data to a new outside service, deploys, pushes, deletes in bulk, or touches keys.

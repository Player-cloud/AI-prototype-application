# Evidence log

What has really been checked, on which computer, and what happened. A claim in a proposal, the PRD or a release note must link to an entry here. A merged PR or a passing unit test alone is not evidence that a user-facing journey works.

## How to add an entry

One file per check session: `YYYY-MM-DD-<short-name>.md`. Each entry says:

- **When and who:** date and time (UK), and who ran it (joshua, or Claude in the cloud).
- **Where:** computer and operating system, app commit, how the app was started (dev mode, installer).
- **What was checked:** the exact commands, or the steps clicked.
- **Result:** passed, failed, blocked, not run. Copy exact numbers; never round a failure away.
- **Limits:** what this does **not** show.

Status words are exact (PRD NFR-06): passed, failed, skipped, blocked, not run, stale, unknown.

## Entries

| Date | Entry | Summary |
| --- | --- | --- |
| 2026-11-13 | [Baseline](2026-11-13-baseline.md) | Linux: all checks passed. Windows CI: 11 test failures (test clean-up), fixed in PR #73; Windows and Ubuntu CI green (run 152). No app click-through yet. |
| 2026-11-13 | [R4 fixes](2026-11-13-r4.md) | PRs #75–#80: name out, Build kept alive, Undo asks, engine restart, Simple view, Build race fix. Linux: 775 tests and 31 Rust tests passed. No click-through yet. |

## Known limits (quoted in the proposal)

| ID | Limit | Since | Tracked in |
| --- | --- | --- | --- |
| L-1 | The installer is not self-contained: it needs the source folder, Node, pnpm and git. Not supported for evaluators until stage R2/R3. | 13 Nov | Readiness plan R2, R3 |
| L-2 | Windows only. Linux and macOS are not supported. | 13 Nov | CUSTOMER_AND_SCOPE.md Q4 |
| L-3 | Building needs a Claude API key. OpenAI and DeepSeek can only test their connection. | 12 Nov | README |
| L-4 | The build agent's safety is checks before each tool call, not an operating-system sandbox. The shell allow-list only logs. | 12 Nov | PRD SEC-08, SEC-10 |
| L-5 | No real-use record yet for phone flows, live view, Capability Centre, experiments, maintenance. | 12 Nov | CURRENT_STATE_AUDIT.md §3 |

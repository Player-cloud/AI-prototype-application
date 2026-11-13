# Customer and scope

**Status:** decided by joshua on 13 Nov 2026 (stage R0 of the readiness plan). This file wins over older wording in [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md) where they differ, until the PRD is rewritten for the company customer.
**Source:** readiness assessment (Claude Doc "AI Prototype: readiness assessment for a company proposal", 13 Nov 2026) and joshua's answers in the project thread.

## Decisions

| ID | Question | joshua's answer (13 Nov 2026) | What it means for the product |
| --- | --- | --- | --- |
| Q1 | Who is the customer? | Companies **license** the app. It must work for **any team size from 1 upward**. | The app stops being "joshua only". Nothing user-facing may name joshua. A one-person install must work on its own; bigger teams must not need a rewrite later (see open question T-1). |
| Q2 | Whose key and budget? | The company brings **its own Claude API key and budget**. | No service run by joshua. Keys stay in each computer's password store. The budget stays a per-install setting for now. |
| Q3 | GitHub sync and phone messages? | **Optional.** | A new install must work with no GitHub account: a local data folder, no sync, no phone. GitHub sync and phone messages are switched on in Settings. |
| Q4 | Platforms for the first evaluation? | **Windows only** is acceptable. | Windows 10/11 x64 is the only platform claimed. Linux stays "not supported yet" until a clean-machine pass. macOS stays out (`CLAUDE.md`). |
| Q5 | Developer tools? | The installer **bundles git, Node and pnpm**. Also look for ways to make this smaller, easier to install and easy to change. | Routine use needs no terminal and no tools installed by hand. See [TOOLCHAIN_OPTIONS.md](TOOLCHAIN_OPTIONS.md). |

## What is in scope for the first company evaluation

- One person installs the app on a clean Windows PC from one installer, with no terminal.
- They save their company's Claude API key, set a budget, plan a small web app, build features, check them, and Keep or Undo them.
- Everything works with GitHub turned off.
- They can see what data leaves the computer and send a diagnostics file with an issue.

## Out of scope for the first evaluation

- Linux and macOS installers.
- A hosted service, shared accounts, central billing or an admin console.
- Deploying the apps it builds, and client handover.
- Building with OpenAI or DeepSeek (Claude only; the others stay connection-test only).

## Open questions (need joshua)

| ID | Question | Why it matters |
| --- | --- | --- |
| T-1 | "Any team size": for the first evaluation, is it enough that each person installs their own copy (one seat each), with shared projects and central settings later? | Sharing projects or a company-wide budget needs a design change (today all records are per computer). Building it now would delay the evaluation. |
| T-2 | Who is the licensor (a person or a company), and which licence type (commercial, per seat)? | Needed for the LICENSE file, the installer's publisher name and code signing. |
| T-3 | Product name: keep "AI Prototype" and the ID `app.aiprototype.desktop`? | The name and ID go into the installer, the Windows menus and the password store. Changing them later moves where settings and keys are kept. |

## What does not change because of these decisions

- The safety rules in `packages/gatekeeper` (only joshua changes them).
- How builds, checks, Keep and Undo work.
- joshua's own setup: his data repo and GitHub sync keep working.

# Gatekeeper hook
What: a small script that checks every agent action before it runs (Claude Agent SDK PreToolUse hook).
Use when: always. Blocks pushes, bulk deletes, reading key files and new outside services unless you approve.
Don't use when: never off. Only the app's owner can edit its rules.
Cost: $0. Round 4: blocked 5/5 risky attempts; the agent didn't try to get around it.

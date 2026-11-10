# Standard web-app stack (build step 7-8)

Next.js + TypeScript, Postgres on Neon, Auth.js, shadcn/ui with Sonner, Vaul (Drawer) and cmdk (Command).

Rules learnt on joshua's Windows laptop (2026-11-10):
- Pin pnpm 10 in each project (`"packageManager": "pnpm@10.34.9"`). npm 12 breaks create-next-app but still reports success.
- Run shadcn with `npx shadcn@latest ...` (not `pnpm dlx`, which fails on pnpm 10).
- Keep pnpm 12's "minimum release age" rule: it refuses packages less than a day old (safety against tampered packages).
- Always check that an install really succeeded (node_modules exists, exit code), not just the command's message.

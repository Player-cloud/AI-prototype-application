import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.{ts,tsx}'],
    // Many engine tests make real git repos and worktrees. On joshua's Windows laptop these take
    // more than vitest's 5-second default (git is slower there), so they timed out while passing.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

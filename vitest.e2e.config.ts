import { defineConfig } from 'vitest/config';

/**
 * E2E test config — runs against real network endpoints (GitHub).
 * Invoked via `npm run test:e2e`. Network ops can be slow; per-test
 * timeout is bumped from the default 5s.
 *
 * Requires:
 *   - SSH agent or `~/.ssh/config` set up for `git@github.com:...`
 *   - Network access to github.com
 *
 * The suite probes SSH access in beforeAll and skips itself with a
 * clear message if the probe fails.
 */
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Run e2e tests sequentially — the GitHub-side cache and our local
    // disk cache aren't designed for parallel access from the same suite.
    fileParallelism: false,
  },
});

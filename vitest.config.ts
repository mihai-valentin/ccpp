import { defineConfig } from 'vitest/config';

/**
 * Default test config. Excludes the network-dependent E2E suite under
 * `tests/e2e/` — those run via `npm run test:e2e` and require SSH access
 * to the test fixture remote. CI runs only this default config.
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
  },
});

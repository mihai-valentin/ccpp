import { defineConfig } from 'vitest/config';

/**
 * Default test config. Excludes the network-dependent E2E suite under
 * `tests/e2e/` — those run via `npm run test:e2e` and require SSH access
 * to the test fixture remote. CI runs only this default config.
 *
 * Coverage: enable with `npm run coverage` (or `npx vitest run --coverage`).
 * Uses the v8 provider, reports text + html + json-summary, and excludes
 * test files / build artifacts / fixtures from the measured set so the
 * percentages reflect the real source surface only.
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        'src/index.ts', // pure type re-export entry — nothing executes
        'dist/**',
        'tests/**',
      ],
    },
  },
});

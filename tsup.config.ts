import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// Read the version once at build time. cli.ts references this via the
// declared `__VERSION__` global; tsup substitutes it as a literal during
// bundling so the runtime never reads package.json (no fs, no __dirname).
const pkgVersion = (
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

const define = { __VERSION__: JSON.stringify(pkgVersion) };

export default defineConfig([
  {
    // Library entry — dual-format (CJS + ESM) so consumers can pick. .d.cts
    // is required for CJS type resolution; .d.ts covers ESM. No source maps
    // shipped — they'd ~triple the tarball size and library consumers debug
    // their own code, not our bundled types.
    entry: { index: 'src/index.ts' },
    format: ['cjs', 'esm'],
    outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.mjs' }),
    dts: true,
    clean: true,
    sourcemap: false,
    target: 'node20',
    platform: 'node',
    define,
  },
  {
    // CLI entry — CJS only. `package.json:bin` points at dist/cli.cjs; no
    // caller ever loads the ESM build, so it was dead weight (~350 KB
    // including its source map). Source maps are off for the same size
    // reason as the library — bug reports get bundled-line numbers, which
    // cross-reference fine against the GitHub source for a given tag.
    entry: { cli: 'src/cli.ts' },
    format: ['cjs'],
    outExtension: () => ({ js: '.cjs' }),
    dts: false,
    clean: false,
    sourcemap: false,
    target: 'node20',
    platform: 'node',
    banner: { js: '#!/usr/bin/env node' },
    define,
  },
]);

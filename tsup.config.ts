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
    entry: { index: 'src/index.ts' },
    format: ['cjs', 'esm'],
    outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.mjs' }),
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'node20',
    platform: 'node',
    define,
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['cjs', 'esm'],
    outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.mjs' }),
    dts: false,
    clean: false,
    sourcemap: true,
    target: 'node20',
    platform: 'node',
    banner: (ctx) => (ctx.format === 'cjs' ? { js: '#!/usr/bin/env node' } : undefined),
    define,
  },
]);

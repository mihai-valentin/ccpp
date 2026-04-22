import { defineConfig } from 'tsup';

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
  },
]);

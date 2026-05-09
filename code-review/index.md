# Module: src/index.ts

**LoC**: 1  •  **Test file**: no (and not needed — there is nothing to test).

## Purpose
Public-package entry point for library-style consumers of the `ccpp` npm package. Re-exports the `Types` namespace from `lib/types.js` so SDK consumers can import shared TypeScript types without reaching into internal paths.

## Public surface
- `Types` — type-only re-export (`export type * as Types from './lib/types.js';`). Consumers can write `import type { Types } from 'ccpp'` and then `Types.Lockfile`, `Types.Conflict`, etc.

## Strengths
- Minimal surface area on purpose. The package is a CLI first; it exposes only what is necessary for type-level interop.
- `export type *` (TS 5.0+) keeps the import erased at compile time — zero runtime cost, no risk of accidentally re-exporting a runtime value.
- The single-file form makes the `package.json` `main`/`types` wiring trivial and impossible to drift.

## Concerns

### Cohesion
A one-line file doing one thing — N/A.

### Coupling
Depends only on `./lib/types.js`. Appropriate.

### Maintainability
Trivial.

### Style
Acceptable. Some readers might prefer naming the namespace less generically than `Types` (e.g. `CcppTypes`), but at the package boundary `Types` is reasonable because the consumer prefixes it with the package name (`Ccpp.Types` after `import * as Ccpp from 'ccpp'`).

## Specific issues
- **src/index.ts:1**: There is no doc comment explaining what this module exists for or why it re-exports only types. A two-line JSDoc would help a future contributor decide whether to add a runtime export here (answer: probably not — keep the CLI surface separate from any future programmatic API).
- **src/index.ts:1**: `Types` as the namespace name is undescriptive. If a programmatic API is ever added, callers will want `import { run } from 'ccpp'` alongside `import type { Types } from 'ccpp'` — fine — but the namespace name will read as `ccpp.Types.Lockfile`, which is mildly redundant. Not blocking.
- No `package.json` entry was inspected here, but if `main`/`types`/`exports` do not point at this file, the re-export is effectively dead. (Check separately.)

## Suggestions
- **[low]** Add a short header comment: `/** Public package entry — type re-exports only. The CLI lives in src/cli.ts. */`
- **[low]** If there is appetite for a programmatic API down the line (e.g. `runSync(opts)` from a Node script), this is the file that should grow. Until that day, leave it alone.

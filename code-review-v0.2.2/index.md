# Module: src/index.ts

**LoC**: 6  •  **Test file**: no (and not needed — there is nothing to test).  •  **v0.2.2 status**: refactored (was 1 LoC; doc comment added)

## Purpose
Public-package entry point for library-style consumers of the `ccpp` npm package. Re-exports the `Types` namespace from `lib/types.js` so SDK consumers can import shared TypeScript types without reaching into internal paths.

## Public surface
- `Types` — type-only re-export (`export type * as Types from './lib/types.js';`). Consumers can write `import type { Types } from 'ccpp'` and reach `Types.Lockfile`, `Types.Conflict`, etc.

## Strengths
- Minimal, deliberate surface area. The package is a CLI first; this entry exposes only what's needed for type-level interop.
- `export type *` keeps the import erased at compile time — zero runtime cost, no risk of accidentally exporting a runtime value.
- The v0.2.1 review's "[low] add a header comment" suggestion is now addressed (lines 1–5).
- Single-file form keeps the `package.json` `main`/`types`/`exports` wiring trivial and impossible to drift.

## Concerns

### Cohesion
N/A — six lines, one statement, one purpose.

### Coupling
Depends only on `./lib/types.js`. Appropriate.

### Maintainability
Trivial. The header comment (lines 1–5) names the design intent and points at `cli.ts` for the runtime entry — exactly the breadcrumb a future contributor needs to decide whether to grow this file or leave it alone.

### Style
- Namespace name `Types` is generic but reads correctly at the package boundary (`Ccpp.Types.Lockfile` after `import * as Ccpp from 'ccpp'`). Acceptable.

## Specific issues
- None. The v0.2.1 finding ("no doc comment explaining the file's role") is resolved.

## Suggestions
- No actionable suggestions. If a programmatic API is ever added (e.g. `runSync(opts)` from a Node script), this is the file that should grow. Until then, leave it alone.

## Resolved from v0.2.1
- Doc comment added (lines 1–5) — resolved.

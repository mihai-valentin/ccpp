# Module: src/lib/types.ts

**LoC**: 191  •  **Test file**: n/a (type-only module)

## Purpose
Shared TypeScript type declarations for the cross-module data shapes: `Source` / `ResolvedSource`, the user-facing `Manifest`, parsed-from-disk `SlashCommand` / `Skill` / `Agent`, the per-source `PluginManifest`, the discovery output `ResolvedManifest`, the persisted `Lockfile` (with `LockSourceEntry` / `LockInstalledEntry`), the marketplace/plugin JSON schemas, and the install-time `Conflict`. No runtime code, no constants, no enums — pure type surface.

## Public surface
- Interfaces: `Source`, `ResolvedSource`, `Manifest`, `SlashCommand`, `Agent`, `Skill`, `PluginManifest`, `ResolvedManifest`, `MarketplaceJson`, `PluginJson`, `Lockfile`, `LockSourceEntry`, `LockInstalledEntry`, `Conflict`

## Strengths
- Every interface has a JSDoc block explaining its role and lifecycle (which producer emits it, which consumer reads it). E.g. lines 17-20 explain that `ResolvedSource` is "produced during a sync / install step and recorded in the lockfile" — orientation for new readers.
- Field-level docs on every property — readers don't need to grep call sites to understand `LockInstalledEntry.sourceSha`'s purpose (line 173).
- `Lockfile.version` is typed as the literal `1` (line 144), enforcing the schema gate at the type level — `version: 2` literally won't compile.
- Distinguishes the *raw on-disk* shape (`MarketplaceJson`, `PluginJson` — lines 120-135) from the *normalized in-memory* shape (`PluginManifest`, `ResolvedManifest` — lines 81-115). That's the right modeling: validators turn the former into the latter.
- Re-exported as a namespace from `src/index.ts:1` (`export type * as Types from './lib/types.js';`) — gives library consumers a single import surface.

## Concerns
### Cohesion
"Shared types" is a real cohesion. The file is 191 LoC across 14 interfaces — manageable. The split between *user-input types* (Source, Manifest), *parsed-from-disk types* (SlashCommand, Skill, Agent, PluginManifest, ResolvedManifest, MarketplaceJson, PluginJson), and *persisted types* (Lockfile, LockSourceEntry, LockInstalledEntry) plus *runtime helper types* (Conflict) is reasonable. If the file grows much beyond this it should split into `types-manifest.ts` / `types-lockfile.ts` / `types-conflict.ts`.

### Coupling
- Zero imports — type-only by definition.
- Used by: `cli.ts`, `lib/installer.ts`, `lib/diff.ts`, `lib/lockfile.ts`, `commands/sync.ts`, `commands/status.ts`, `commands/status.test.ts`, plus the public `index.ts` re-export.
- **Soft over-sharing**: `MarketplaceJson` and `PluginJson` (lines 120-135) are *raw shapes for the parser*. They're declared here, but only the manifest parser should construct or read them. Exporting them from `types.ts` invites callers to bind to the raw shape. Today only `manifest.ts` references them (`grep` would confirm). Either keep them here and document "internal — parser only", or move to `manifest.ts` so the public type surface is the *normalized* form.
- `Source` (line 6-15) carries `subpath?` (line 14) but I don't see `subpath` used in any of the code paths I reviewed. If it's declared-but-unimplemented, it's misleading. Verify against the parser/installer; if unused, mark as `// reserved for v0.x.y` or remove.

### Maintainability
- One well-known footgun for a shared types module: every consumer compiles every type. With 14 interfaces, build time impact is invisible. No issue.
- `Manifest.version` is `number` (line 34) but `Lockfile.version` is the literal `1` (line 144). Asymmetry. Both are versioned, both should likely be literal-typed for the schema gate to be enforced at the type level. Today `version` in `Manifest` accepts any number, leaving validators to enforce.
- `PluginManifest.author` is `string | { name: string }` (line 89) — a union shape mirroring npm's `package.json` author convention. Acceptable; consumers should normalize at the boundary, not branch every read.
- `Conflict.name` (line 190) is annotated as "Short name (command, skill, or agent) that collided" — but there's no enum/tag for *which* of the three. Adding `kind: 'command' | 'skill' | 'agent'` to `Conflict` would let the user-facing message read "command 'foo' would be overwritten" instead of "'foo' would be overwritten". Today the disambiguation is left to the destination path; a typed tag would be cleaner.
- `LockInstalledEntry.sourcePath` (line 171) is described as "relative to its root" — but doesn't specify which root. Comparing with installer code shows it's relative to the *manifest sourceDir*, not necessarily the repo root if `subpath` is used. Tighten the docstring.
- No unused interfaces I can spot from grep — all are imported somewhere.

### Style
- Field doc comments are short and specific. Consistent style.
- Naming convention: types are `PascalCase` interfaces; no type aliases for shape types — consistent.
- `MarketplaceJson.plugins` (line 123) is `Array<{ name: string; source: string; description?: string }>` — an inline anonymous shape. Two options: leave as inline (it's a one-off) or hoist as `MarketplacePluginEntry`. The current inline form is fine; flagging only for awareness if it ever needs reuse.
- No emojis, no TODOs, no dead code.

## Specific issues
- `src/lib/types.ts:14` — `Source.subpath?: string` may be declared-but-unused. Verify against `manifest.ts` / `installer.ts`; if unused, either implement, document as reserved, or remove.
- `src/lib/types.ts:34` — `Manifest.version: number` should be a literal type (or a union of supported literals) to enforce the schema gate at compile time, matching `Lockfile.version: 1` (line 144).
- `src/lib/types.ts:120-135` — `MarketplaceJson` and `PluginJson` are raw on-disk shapes used only by the parser. Either move to `manifest.ts` (private to that module) or annotate as "internal — parser-only; consumers should use `ResolvedManifest`".
- `src/lib/types.ts:171` — `LockInstalledEntry.sourcePath` doc says "relative to its root" — clarify *which* root (manifest source dir, repo root, claudeHome).
- `src/lib/types.ts:182-191` — `Conflict` lacks a `kind` discriminator. Adding `kind: 'command' | 'skill' | 'agent'` enables typed UX messages.
- `src/lib/types.ts` exposes everything via `export type * as Types from './lib/types.js'` (`src/index.ts:1`). That's the entire internal type surface. If even one of these (`MarketplaceJson`, `Conflict`) shouldn't be in the public API, the re-export will leak it. Audit what's intended public-API vs internal.

## Suggestions
- **[medium]** Tighten `Manifest.version` to a literal (`1` today) for compile-time schema gating.
- **[medium]** Add a `kind: 'command' | 'skill' | 'agent'` discriminator to `Conflict` so the CLI can render specific messages without inferring from path.
- **[medium]** Audit `Source.subpath` — implement, mark reserved, or remove. Type drift hurts readers.
- **[medium]** Decide whether `MarketplaceJson` / `PluginJson` should be public or parser-private; if private, move them to `manifest.ts`.
- **[low]** Tighten the docstring on `LockInstalledEntry.sourcePath` to name the exact root.
- **[low]** Audit `index.ts:1`'s `export type *` re-export against the actual intended public API; consider an explicit allowlist (`export type { Manifest, Source, ResolvedManifest, ... } from ...`) instead of star-export, so type leakage is intentional.

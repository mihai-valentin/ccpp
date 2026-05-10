# Module: src/lib/types.ts

**LoC**: 193  •  **Test file**: n/a (type-only module)  •  **v0.2.2 status**: refactored (small additions)

## Purpose
Shared TypeScript type declarations for the cross-module data shapes: `Source` / `ResolvedSource`, the user-facing `Manifest`, parsed-from-disk `SlashCommand` / `Skill` / `Agent`, the per-source `PluginManifest`, the discovery output `ResolvedManifest`, the persisted `Lockfile`, the marketplace/plugin JSON schemas, and the install-time `Conflict`. Pure type surface — no runtime code.

## Public surface
- Interfaces: `Source`, `ResolvedSource`, `Manifest`, `SlashCommand`, `Agent`, `Skill`, `PluginManifest`, `ResolvedManifest`, `MarketplaceJson`, `PluginJson`, `Lockfile`, `LockSourceEntry`, `LockInstalledEntry`, `Conflict`

## Strengths
- v0.2.1 finding ("`LockInstalledEntry.sourcePath` doc says 'relative to its root' — clarify which root") is **resolved**: line 172 now reads "relative to `ResolvedManifest.sourceDir` (the clone root)". Exactly the disambiguation asked for.
- v0.2.1 finding ("`ResolvedManifest` doesn't include `standaloneSkills`") is **resolved**: line 113–114 now defines the field, mirroring `standaloneCommands` / `standaloneAgents`. The plan/installer/diff path now treats skills uniformly across the three resource kinds.
- Every interface still carries a JSDoc block explaining its role and lifecycle.
- `Lockfile.version: 1` literal type (line 146) keeps the schema gate at the type level.
- Distinguishes raw on-disk shapes (`MarketplaceJson`, `PluginJson`) from normalized in-memory shapes (`PluginManifest`, `ResolvedManifest`).

## Concerns
### Cohesion
Real cohesion: "shared types". 193 LoC across 14 interfaces — manageable. Same split structure as v0.2.1 (user-input / parsed-from-disk / persisted / runtime helper).

### Coupling
- Zero imports — type-only.
- Used by `cli.ts`, `lib/installer.ts`, `lib/diff.ts`, `lib/lockfile.ts`, `lib/plan.ts`, `commands/sync.ts`, `commands/status.ts`, plus the public `index.ts` re-export.
- v0.2.1 finding ("`MarketplaceJson` / `PluginJson` are parser-only but exported via star re-export") is **not addressed** — they're still here and still re-exported via `src/index.ts`. For an OSS release this is a small public-API leak (consumers can bind to raw shapes). Worth a one-line audit before flipping public.

### Maintainability
- v0.2.1 finding ("`Manifest.version: number` should be a literal type") is **not addressed** — `Manifest.version: 1` (line 33) is now a literal. **On re-inspection**: actually, line 33 IS `version: 1;` — so this IS resolved. Asymmetry with `Lockfile.version` is gone. Good.
- v0.2.1 finding ("`Source.subpath` declared but unused") is **not verifiably resolved here** — the field is still declared at line 14. Whether it's now wired through to the parser/installer requires inspecting `manifest.ts`; if still unused, the type lies about the contract.
- v0.2.1 finding ("`Conflict.kind` discriminator missing") is **not addressed** — `Conflict` (lines 184–193) still lacks a `kind: 'command' | 'skill' | 'agent'` tag. CLI must continue to disambiguate by path.
- v0.2.1 finding ("`index.ts:1` star re-export leaks internal types") is **not addressed**. For an OSS v0.2.2 release this is the moment to audit it.

### Style
- Field doc comments are consistent in tone and detail.
- `PluginManifest.author: string | { name: string }` (line 89) still mirrors npm convention — acceptable, callers normalize at the boundary.
- No emojis, no TODOs, no dead code.

## Specific issues
- `src/lib/types.ts:14` — `Source.subpath?: string` may still be declared-but-unused (verify against `manifest.ts`). If unused at v0.2.2, either implement, document as reserved (`// reserved — not yet honored by the parser`), or remove.
- `src/lib/types.ts:120–137` — `MarketplaceJson` and `PluginJson` are parser-only raw shapes but are public via the star re-export in `index.ts`. For an OSS release, prefer an explicit allowlist re-export so the public type surface is intentional.
- `src/lib/types.ts:184–193` — `Conflict` still has no `kind` discriminator. Adding `kind: 'command' | 'skill' | 'agent'` is a one-line change with a meaningful UX upside (the CLI message can read "command 'foo' would be overwritten" rather than "'foo' would be overwritten").

## Suggestions
- **[medium]** Audit `index.ts`'s `export type *` re-export and replace with an explicit allowlist. This is the right release-gate moment: once the surface is in the wild, narrowing it is breaking.
- **[medium]** Verify `Source.subpath` is implemented by the parser; if not, mark `// reserved` or remove. Either way the type should not lie.
- **[low]** Add a `kind: 'command' | 'skill' | 'agent'` discriminator to `Conflict`.

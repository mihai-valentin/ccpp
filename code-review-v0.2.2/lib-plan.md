# Module: src/lib/plan.ts

**LoC**: 114  •  **Test file**: yes — `src/lib/plan.test.ts` (131 LoC)  •  **v0.2.2 status**: NEW in v0.2.2

## Purpose
The single source of truth for "given a `ResolvedManifest` and a `claudeHome`, what files would land where". Returns a flat list of `PlannedFile` entries that both `installer.applyManifest` (for actual writes) and `diff.computeChangeset` (for the dry-run preview) consume. Eliminates the v0.2.1 drift bug where the two callers maintained separate planners and one wasn't updated when agents were added.

## Public surface
- Types: `PlannedFile`
- Functions: `planFiles`

## Strengths
- **Solves v0.2.1 finding #17 cleanly.** Verified: `installer.ts:5` and `diff.ts:3` both import `planFiles` from `./plan.js`; no duplicate planner remains in either file. Every grep for `pushCommand`/`pushSkill`/`pushAgent` lands in this file. Single source of truth.
- The order rule is documented inline (lines 26–33): "standalone commands → skills → agents → plugin commands → skills → agents; first writer wins". This makes the dedup logic at line 67 / 79 / 94 deterministic.
- Order is regression-pinned by `plan.test.ts:73` ("routes plugin commands, skills, and agents under the same flat dirs") and `:106` (dedup test for first-writer-wins across resource kinds).
- The `seenDests` dedup (line 37) handles the cross-resource-kind collision case (e.g. a standalone agent vs a plugin agent with the same dest path) — silently dropped in the plan, with a comment explaining the reasoning ("that case is caught upstream as a collision warning by `manifest.parseManifest`").
- `PlannedFile` is the lockstep contract between installer and diff: documented field-by-field at lines 14–23.
- Helpers `pushCommand` / `pushAgent` / `pushSkill` / `pushPluginContents` are short and single-purpose. Order-of-args is consistent across them.

## Concerns
### Cohesion
Pure planner. One job: "manifest → list of (source, dest) tuples". Doesn't read or write files. Doesn't make collision decisions (those happen in `installer.preparePlan` against the lockfile). Right boundary.

### Coupling
- Imports `node:path` (`join`, `relative`) plus `./layout.js` for `CLAUDE_LAYOUT` and `./types.js` for the manifest types. Minimal.
- Used by `installer.ts` and `diff.ts` and `plan.test.ts`. Exactly the consumer set the extraction was for.

### Maintainability
- 114 LoC, 5 small functions, none over 25 lines.
- The `PlanCtx` private interface (lines 56–58) bundles `claudeHome` + `sourceDir` so each helper has a 4-arg signature. Slightly awkward (the `seenDests` set is the one piece of mutable state passed alongside) but readable.
- `pushSkill` (lines 89–103) is the most complex helper: walks `skill.files`, computes per-file relative paths, dedupes inside a single skill (rare case where the same file path appears twice). Test `plan.test.ts:41` pins the `skills/<name>/<rel>` layout.
- All helpers `seenDests.has(destPath); return/continue;` pattern — minor duplication but straightforward.

### Style
- Header comment at lines 5–13 explains the module's *raison d'être* (the v0.2.0 agents drift bug). Good — anchors the reader to why the module exists.
- Doc comments on `planFiles`, `PlannedFile`, every helper.
- Naming consistent (`items`, `seenDests`, `ctx`, `cmd`, `skill`, `agent`).
- No emojis, no TODOs, no dead code.

## Specific issues
- `src/lib/plan.ts:60–87` — `pushCommand` and `pushAgent` are byte-twins except for the `CLAUDE_LAYOUT.commands` vs `CLAUDE_LAYOUT.agents` constant and the `name` field source (`cmd.sourceFile` / `agent.sourceFile`). Could be unified as `pushFlat(items, seenDests, ctx, kind, item)` taking a `ResourceKind` discriminator. Cosmetic — the current shape is at most 8 duplicated lines and stays readable.
- `src/lib/plan.ts:89–103` — `pushSkill` does not check whether `skill.files` includes the skill's `SKILL.md` itself. It assumes the manifest parser produced a complete file list. If the parser ever changes, this is silently wrong. A test pinning "skills always include SKILL.md as the first file" would be defensive.
- `src/lib/plan.ts:34–53` — `planFiles` accepts `claudeHome` as a path string; no validation that it's absolute. If a caller passes a relative path, `join(claudeHome, …)` produces a relative destPath; downstream `pathExists` / `fs.readFile` then resolve against `process.cwd()`, which may not be intended. Today every caller passes an absolute path; documenting the precondition would help.

## Suggestions
- **[low]** Unify `pushCommand` and `pushAgent` into a single `pushFlat(items, seenDests, ctx, kind, item)` helper. Saves ~10 LoC. Acceptable as-is.
- **[low]** Document the absolute-path precondition on `claudeHome` in the `planFiles` doc comment (or assert it).
- **[low]** Add a defensive test pinning that `pushSkill` includes every file the parser declared in `skill.files`.

# Module: src/lib/diff.ts

**LoC**: 85  •  **Test file**: yes — `src/lib/diff.test.ts` (326 LoC)  •  **v0.2.2 status**: refactored (heavy shrinkage — 153 LoC → 85 LoC)

## Purpose
Computes a dry-run "what would change" report for a single source given a manifest, claudeHome, and the lockfile (added / modified / removed / unchanged). Output is what the CLI shows users before they confirm a sync. Mirrors `installer.applyManifest`'s on-disk behaviour without writing.

## Public surface
- Types: `Changeset`, `ComputeChangesetOptions`
- Functions: `computeChangeset`, `hasChanges`

## Strengths
- v0.2.1 finding ("`planFiles` reimplementation drops `standaloneAgents` and `plugin.agents` — correctness bug") is **resolved**: this module no longer carries a parallel planner. It imports `planFiles` from `./plan.js` (line 3), called once at line 41. Single source of truth — no drift possible.
- v0.2.1 finding ("`pathExists` duplicated") is **resolved**: line 2 imports it from `./fsutil.js`.
- v0.2.1 finding ("`sourceSha` declared but unused") is **resolved**: `ComputeChangesetOptions` (lines 27–33) keeps `sourceSha` because the type carries the producer/consumer contract — wait, on inspection `sourceSha` is still in the options type and not read inside the function. Worth flagging again (see Specific issues).
- Stable sort on output lists (lines 73–76) keeps summary rendering and tests deterministic.
- Comment at lines 56–58 documents the asymmetric trust model (source = partially trusted via `readFileSafe`, dest reads = `fs.readFile` because `~/.claude/` is the user's own dir). Same model as installer.

## Concerns
### Cohesion
Now genuinely single-purpose: build a `Changeset` from a plan + lockfile + filesystem. The previous bloat (parallel planner) is gone.

### Coupling
- Imports `node:fs`, `./fsutil.js`, `./plan.js`, `./types.js`. Exactly the right surface.
- Lockstep with installer is now structural (both call the same `planFiles`), not by-convention. Drift risk is gone.

### Maintainability
- 85 LoC, one main function (`computeChangeset` at lines 40–79, 40 lines), one trivial helper (`hasChanges`).
- Per-file byte compare uses `Promise.all` on source+dest reads (line 59) — small parallel speedup retained.
- No magic strings — all directory names live in `lib/layout.ts` via `plan.ts`.

### Style
- Doc on `Changeset` (lines 12–25) is precise per field, including the "v0.1.1 doesn't auto-delete removed files" caveat.
- Naming consistent with installer.
- No emojis, no TODOs.

## Specific issues
- `src/lib/diff.ts:27–33` — `ComputeChangesetOptions.sourceSha` is still declared in the options type but is never read inside `computeChangeset`. This was flagged in v0.2.1 and was not resolved in this round. Either remove it or document why the call sites pass it (they shouldn't have to construct a value that's discarded). Minor — no behavioural impact.
- `src/lib/diff.ts:70` — `for (const dest of priorDests) changeset.removed.push(dest);` could be `changeset.removed.push(...priorDests)`. Cosmetic, same nit as v0.2.1.

## Suggestions
- **[low]** Drop `sourceSha` from `ComputeChangesetOptions` (and the corresponding callers in `commands/sync.ts` / tests) so the type doesn't lie about what the function consumes.
- **[low]** Replace the `priorDests` for-loop at line 70 with `changeset.removed.push(...priorDests)`. Cosmetic.

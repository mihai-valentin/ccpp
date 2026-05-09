# Module: src/lib/diff.ts

**LoC**: 153  •  **Test file**: yes — `src/lib/diff.test.ts` (269 LoC)

## Purpose
Computes a dry-run "what would change" report for a single source given a manifest, claudeHome, and the current lockfile. The output (`Changeset`: added / modified / removed / unchanged) is what the CLI shows users before they confirm a sync. Deliberately scoped to mirror `installer.applyManifest`'s file-write behaviour without performing writes.

## Public surface
- Types: `Changeset`, `ComputeChangesetOptions`
- Functions: `computeChangeset`, `hasChanges`

## Strengths
- Strict input/output contract (`Changeset`'s field semantics are documented inline at lines 13-25).
- Hardens the source-side read against symlink attacks via `readFileSafe` (line 61) — preserving the security boundary established in `fsutil.ts`. The comment at lines 57-59 even explains the asymmetry: source = partially trusted, dest (~/.claude/) = trusted.
- Stable sort on output lists (lines 74-77) so summary rendering and tests are deterministic.
- `Promise.all` parallelism on the per-file byte compare (line 60) — small touch, but keeps the diff fast on multi-file skills.
- Bytewise `Buffer.equals` (line 143) avoids any string/encoding pitfalls that could mis-flag a CRLF-vs-LF file as "modified" in noisy ways.

## Concerns
### Cohesion
Single-purpose module. The `planFiles` helpers (lines 88-140) are intentionally a parallel reimplementation of `installer.planFiles`, with the comment at lines 88-90 acknowledging the duplication. That's the biggest cohesion issue and it's a *cross-module* problem (see Specific issues).

### Coupling
- Imports `fsutil.readFileSafe` (good), `types.ts` (types only — clean).
- Mirrors private logic from `installer.ts:153-238` — this is a structural coupling: any change to file layout in installer.ts must be replicated here, and the test for that contract lives only in `installer.test.ts`. The comment at line 89-90 says "installer.ts is intentionally closed for modification" but that's not enforced; it's a convention. Drift risk.

### Maintainability
- `computeChangeset` (lines 41-80) is 40 lines, single loop, readable.
- `pushSkill` / `pushPluginContents` / `pushCommand` (lines 104-140) replicate the destPath-derivation rules. **They are silently incomplete** — see Specific issues.
- Magic absent: `'commands'` and `'skills'` directory names are hardcoded (lines 110, 132) and also hardcoded again in `installer.ts:175, 226`. These names are part of Claude Code's filesystem contract; a `const CLAUDE_DIRS = { commands, skills, agents }` shared between diff and installer would prevent typos and make the dependency on Claude Code's layout grep-able.
- Error handling is minimal because the function is pure-ish (only fs reads), and `readFileSafe` and `fs.readFile` propagate their own clear errors. Acceptable.

### Style
- Naming consistent with installer.ts.
- The `seenDests` dedup (line 94) is needed because two skills could declare the same nested file path under their own roots. The comment is missing — a one-liner would help.
- `ComputeChangesetOptions` doesn't include `sourceUrl`/`sourceSha` documentation explaining why they're needed (they are — `sourceUrl` is used at line 47 to filter the prior-installed set; `sourceSha` is unused and dead).

## Specific issues
- `src/lib/diff.ts:92-101` — `planFiles` does not handle `manifest.standaloneAgents` or per-plugin `plugin.agents`. The `Agent` type in `types.ts:58-63` exists, and `installer.ts:160-162, 198-200` writes them to `~/.claude/agents/<name>.md`. **Result: agents installed by `applyManifest` will appear as "added" or "modified" on the *next* diff because the prior-installed set is built from the lockfile (line 46-48) but the new plan doesn't generate them — they will end up in `priorDests` and be reported as `removed`.** This is a correctness bug introduced by the agents feature.
- `src/lib/diff.ts:30-33` — `ComputeChangesetOptions.sourceSha` is declared but never read inside the function. Dead field.
- `src/lib/diff.ts:88-90` — comment says "installer.ts is intentionally closed for modification in this task" but the task is long over. Either extract a shared `planFiles(manifest, claudeHome): PlannedFile[]` helper that both modules import, or delete the stale comment and replace it with a "must stay in lockstep with installer.planFiles" warning + a unit test that asserts the two return identical destPaths for fixture manifests.
- `src/lib/diff.ts:146-153` — `pathExists` is byte-identical to `git.ts:164-171`. Move to `fsutil.ts`.
- `src/lib/diff.ts:71` — `for (const dest of priorDests) changeset.removed.push(dest);` could be `changeset.removed.push(...priorDests)`. Minor.
- `src/lib/diff.ts:35-39` — internal `PlannedFile` interface drops the `sourceRelative` field that `installer.PlannedFile` carries. That's because diff doesn't write lockfile entries, so it doesn't need it; fine, but it's another structural divergence to document.

## Suggestions
- **[high]** Fix the agents omission: add `pushAgent` and iterate `manifest.standaloneAgents` + `plugin.agents`. Without this, the diff is wrong as soon as a source ships an agent.
- **[high]** Extract `planFiles` (and its `pushCommand` / `pushAgent` / `pushSkill` / `pushPluginContents` family) into a shared helper file (e.g. `src/lib/plan.ts`) consumed by both `installer.ts` and `diff.ts`. The `PlannedFile` shape can stay caller-specific (different metadata needs), but the destPath rules must live in exactly one place.
- **[medium]** Remove the unused `sourceSha` from `ComputeChangesetOptions` (or document why it's there for future use; the test file may already exercise it — check).
- **[medium]** Move `pathExists` into `fsutil.ts`.
- **[low]** Add a one-liner comment explaining the `seenDests` dedup at line 94.
- **[low]** Centralize the directory names `'commands'`, `'skills'`, `'agents'` into a shared constant.

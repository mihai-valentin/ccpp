# Module: src/lib/installer.ts

**LoC**: 283  •  **Test file**: yes — `/home/mihai/xlnf/ccpp/src/lib/installer.test.ts` (522 LoC)  •  **v0.2.2 status**: heavily refactored

## Purpose
The write-side of ccpp: take a parsed `ResolvedManifest` plus a clone SHA and a target `claudeHome`, plan every file that would land on disk (delegated to `lib/plan.ts`), then prepare → stage → commit each file via a 3-phase pipeline. Backs up changed files, surfaces collisions instead of clobbering, and updates the lockfile in lockstep. Also exposes `removeFromLockfile` for the inverse.

## Public surface
- **Types**: `ApplyManifestOptions`, `ApplyManifestResult`, `RemoveFromLockfileOptions`, `RemoveFromLockfileResult`.
- **Functions**: `applyManifest()`, `removeFromLockfile()`.
- **Internal**: `ToWriteItem`, `StagedItem`, `PreparedPlan`, `StagedPlan` (interfaces); `preparePlan`, `stagePlan`, `commitStaged`, `lockEntry`, `backupStamp`.

## Strengths
- **3-phase split is correct and the boundaries are real**: `preparePlan` (152–198) is read-only against the source/dest filesystems and produces an in-memory classification (skip / unchanged / conflict / write). `stagePlan` (207–226) writes every byte to a sibling staging dir under `claudeHome`, with full rollback (`fs.rm` on any failure) before any production file is touched. `commitStaged` (235–267) does only the rename-into-place + lockfile-mutate. Each phase has a single concern and the data flow is `plan → preparedPlan → stagedPlan → commitOutput`, no back-edges.
- **Atomic-on-same-fs guarantee is now real**: staging under `<claudeHome>/.ccpp-staging-<id>/` (208–209) ensures the eventual `fs.rename` is on the same filesystem. The doc comment at 200–206 names this contract.
- **Failure semantics are documented** at 56–62: phase 4 (`commitStaged`) is best-effort atomic per file but not cross-file transactional; staging tree stays put on partial phase-4 failure for manual recovery. Closes the v0.2.1 "no rollback semantics" finding by making the contract explicit and by adding the staging-tree-survives-failure recovery hook.
- **Symlink protection preserved** via `readFileSafe` (182). Comment at 179–181 names the threat model — partially-trusted sources cannot redirect the read via symlink.
- **`pathExists` deduplication closed**: now imported from `lib/fsutil.ts` (line 4), not duplicated in installer.ts and manifest.ts. Resolves the v0.2.1 high-priority finding.
- **`backupStamp` collision-proof**: the v0.2.1 finding ("two backups in the same millisecond would collide") is fixed at 278–283 — now `${ts}-${randomBytes(2).toString('hex')}` so two simultaneous backups can't overwrite each other.
- **`buffersEqual` removed**: `Buffer.equals(...)` called directly at line 187. Closes a v0.2.1 low.
- **CLAUDE_LAYOUT centralisation**: `'commands'`, `'skills'`, `'agents'` magic strings moved to `lib/layout.ts` and consumed by `lib/plan.ts` (which now owns the path-derivation rule). Installer no longer carries these strings.
- **`planFiles` extracted to `lib/plan.ts`**: pure planning logic is now testable in isolation (plan.test.ts, 131 LoC). Closes the v0.2.1 medium ("could be split for `--dry-run`").

## Concerns

### Cohesion
The module is sharply focused on the apply pipeline. `removeFromLockfile` (96–119) is the inverse and belongs here. No mixed responsibilities. The internal types (`ToWriteItem`, `StagedItem`, `PreparedPlan`, `StagedPlan`, 123–144) form a small data-shape vocabulary for the pipeline — appropriate.

### Coupling
- Imports `node:crypto`, `node:fs`, `node:path`, `lib/fsutil`, `lib/plan`, `lib/types` (1–6). All appropriate.
- Does not import any `commands/*` module. Direction is correct.
- Does not throw `UserError`/`EnvError`/`CollisionError` itself — returns `Conflict[]` and lets caller throw. Right boundary.
- `preparePlan` mutates `opts.lockfile.installed` for unchanged items (189) and `commitStaged` mutates it again at 258. The lockfile-mutation contract is split across two phases — see Maintainability.

### Maintainability
- **`applyManifest` is 27 effective lines** (63–89) — extremely readable now. The four-phase orchestration is one read-through.
- **`preparePlan` (152–198) is 47 lines** — the body is a single loop with clear branch structure (existing-entry-conflict → preferred-source-resolution → read-and-compare → push-to-toWrite). Doc comment at 146–151 explains the scope.
- **`stagePlan` (207–226) is 20 lines** — single loop, single try/catch with rm-on-failure. Comment at 200–206 names the same-fs invariant.
- **`commitStaged` (235–267) is 33 lines** — single loop, two-arm if/else for backup-then-rename vs first-write-rename, plus the lockfile mutation and final cleanup. Tight.
- **Lockfile mutation is split across two phases.** `preparePlan` writes lockfile entries for *unchanged* files (189) — i.e. records that this source still owns this destination at the new SHA, even though no bytes were written. `commitStaged` writes lockfile entries for *installed/updated* files (258). The split is correct (unchanged files don't go through staging) but the documentation could explicitly call this out — today the reader has to notice the line-189 mutation to understand why `commitStaged` only handles the toWrite items. A comment near 189 like `// Update the lockfile pin for unchanged files even though no bytes are written — the SHA may have advanced.` would help.
- **Empty-toWrite short-circuit (69–77)**: when nothing needs writing, `applyManifest` returns early with `unchanged` + `conflicts` and skips both staging and commit. Correct, but the lockfile mutations from `preparePlan`'s unchanged-handling (189) have already happened — the caller's lockfile is updated even though the report says "no changes." Fine, but worth a doc-comment line.
- **`backupStamp()` is called once per phase-4 file** (249) — for many simultaneous files in one apply run, each gets a fresh ISO+random stamp, so collisions within a single applyManifest call are also impossible.
- **`removeFromLockfile` uses `randomBytes` indirectly** through `backupStamp` (109). Same dedup story.
- **Magic string `.ccpp-staging-` (209)** — only used here; not worth centralising. The id format (`Date.now()-randomHex`) is documented at 208.
- **Doc-comment at 38–62 is excellent** — names every phase, the contract for each phase, and the partial-failure recovery story.

### Style
- **Internal data types (123–144)** are small and named. No `Record<string, unknown>` leaks; no `as` casts.
- **`now: string` threaded through all three phases (65, 67, 80, 156, 238)** — a single ISO timestamp is captured at 65 and reused for all lockfile entries this apply run. Correct: every lockfile mutation in one apply has the same `installedAt` value.
- **`{ ToWriteItem, StagedItem }` shapes** carry just enough state across phase boundaries (`item`, `sourceBytes`, `destExists` for stage; `item`, `stagePath`, `destExists` for commit). No bag-of-state smell.
- **Naming**: `preparePlan`, `stagePlan`, `commitStaged` is consistent and self-documenting. `prepared` / `staged` / `committed` variables in `applyManifest` (67, 79, 80) line up.
- **No backup is created on rename when `destExists` is true and we're about to overwrite** — line 250 renames the existing file to `.bak.<ts>` *before* renaming the staged file in (252). Correct order; a partial failure between these two renames leaves the destination missing but the backup intact (recoverable).

## Specific issues
- **lib/installer.ts:189**: lockfile mutation in `preparePlan` for unchanged items is a quiet side effect on what reads as a classification function. Add an inline comment explaining why an unchanged file still updates the lockfile.
- **lib/installer.ts:69–77**: early return when `toWrite.length === 0` is correct but masks the fact that `preparePlan` *has* mutated `opts.lockfile.installed` already. A sentence in the doc comment at 38–62 saying "lockfile may be mutated in phase 2 even when phase 3/4 are skipped" would close that gap.
- **lib/installer.ts:215**: `relative(claudeHome, item.destPath)` assumes `item.destPath` is always under `claudeHome`. `lib/plan.ts:planFiles` builds it that way (`join(ctx.claudeHome, ...)`), so the invariant holds — but if a future change to `planFiles` ever produced an absolute path outside `claudeHome`, the relative call would emit `../...` segments and the staging path would land elsewhere on the filesystem. A defensive `assert(item.destPath.startsWith(claudeHome))` or a planning-time guard would harden this.
- **lib/installer.ts:209**: `Date.now()` produces the staging-id; if two ccpp processes run in the exact same millisecond on the same `claudeHome`, the random suffix (4 hex chars = 65k entropy) makes collision astronomically unlikely. Fine in practice; not worth widening.
- **lib/installer.ts:165–166**: empty branch with a comment-only body (`// Incoming source explicitly preferred → fall through to write.`) — same v0.2.1 stylistic finding. Functional, but unconventional. Inverting to handle the skip case first (`else if (preferred === existing) continue;` first, then the write fall-through) would read cleaner.
- **lib/installer.ts:184–192**: when `destExists` and `sourceBytes.equals(destBytes)` (188), the file is added to `unchanged` and `lockfile.installed[item.destPath]` is updated. When the SHA on the existing entry is older than `opts.sourceSha`, this is the right behavior (advance the pin). When the entry already references a *different* sourceUrl, the conflict guard at 161 catches it. But a same-source same-bytes overwrite still mutates `installedAt`. The behavior matches the v0.2.1 contract (test installer.test.ts confirms); call it out in the doc.
- **lib/installer.ts:96–119**: `removeFromLockfile` doesn't use the staging pipeline (a remove is just a rename to .bak), and the `backups` field still semantically means "what we moved out of the way." Consistent with `applyManifest`'s `backups` field. No issue.

## Suggestions
- **[medium]** Add an inline comment at line 189 explaining why `preparePlan` mutates the lockfile for unchanged items (the SHA may have advanced even when bytes haven't). Also extend the doc comment (38–62) to say "lockfile may be mutated in phase 2 even when phases 3+4 are skipped."
- **[low]** Add a defensive `assert(item.destPath.startsWith(claudeHome))` (or an explicit guard) before `relative(claudeHome, item.destPath)` at line 214–215 — protects against a future planning bug from leaking the staging tree outside `claudeHome`.
- **[low]** Restructure the empty-branch comment at 165–166 by reversing the condition (handle the skip case first, then fall through). Same v0.2.1 stylistic suggestion.
- **[low]** Document in the `ApplyManifestResult` doc comment (or on `applyManifest`'s) that the lockfile is mutated as a side effect — including for unchanged items.

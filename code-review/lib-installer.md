# Module: src/lib/installer.ts

**LoC**: 265  •  **Test file**: yes — `/home/mihai/xlnf/ccpp/src/lib/installer.test.ts` (453 LoC)

## Purpose
The write-side of ccpp: take a parsed `ResolvedManifest` plus a clone SHA and a target `claudeHome`, plan every file that would land on disk, then write them — backing up changed files, surfacing collisions instead of clobbering, and updating the lockfile in lockstep. Also exposes `removeFromLockfile` for the inverse.

## Public surface
- Types: `ApplyManifestOptions`, `ApplyManifestResult`, `RemoveFromLockfileOptions`, `RemoveFromLockfileResult`
- Functions: `applyManifest()`, `removeFromLockfile()`
- Internal: `PlannedFile` interface; `planFiles`, `pushCommand`, `pushAgent`, `pushSkill`, `pushPluginContents`, `lockEntry`, `backupStamp`, `buffersEqual`, `pathExists`

## Strengths
- **Plan/execute split is the right shape**: `planFiles` (lines 153-167) builds an in-memory list of `PlannedFile` records first; the write loop in `applyManifest` (lines 74-118) consumes that list. This makes the flow easy to reason about and would make a future `--dry-run` trivial.
- **Conflict detection is non-destructive by design** (lines 75-92): when two sources want the same dest and `preferredSources` doesn't pick a winner, it appends to `result.conflicts` and `continue`s — disk and lockfile both untouched. The test suite covers this exhaustively (installer.test.ts:244-279).
- **Backup-then-write** for changed files (lines 108-110): the existing file is renamed to `<path>.bak.<ts>` before the new bytes are written. The test at installer.test.ts:217-242 confirms backup contents == prior version.
- **Safe-read at the file boundary**: `readFileSafe` (line 98) is a security-conscious lstat-then-read that refuses symlinks. The comment at lines 95-97 documents the threat model precisely. Test at installer.test.ts:404-428 verifies the guard fires even when manifest construction is bypassed.
- **Agent path mirrors the command path cleanly** (lines 203-218 vs 169-184): `pushAgent` and `pushCommand` are structurally identical; `pushPluginContents` calls them through the same dispatch. Adding agents in v0.2.0 didn't introduce drift.
- **Lockfile is mutated by reference** (lines 105, 117), keeping the data flow predictable: caller owns the lockfile object, `applyManifest` updates it in place, caller writes it. Matches how `cli.ts:235-298` actually uses it (single write at the end).
- `seenDests` set (line 155) makes `planFiles` idempotent against duplicate emits — e.g. when standalone and plugin-scoped paths overlap.

## Concerns
### Cohesion
The module does one thing: project a parsed manifest onto disk and into the lockfile. `removeFromLockfile` is the inverse and belongs here. No mixed responsibilities.

### Coupling
- Imports `node:fs`, `node:path`, `./fsutil.js` for `readFileSafe`, and 8 named types from `./types.js` (lines 1-13). All appropriate.
- Does not import any `commands/*` module — correct direction; the dependency arrow is from cli/commands → lib.
- Does not throw `UserError`/`EnvError`/`CollisionError` itself — instead it returns a `Conflict[]` and lets the caller throw. This is the right boundary: lib stays I/O-pure(-ish), cli does taxonomy.

### Maintainability
- `applyManifest` is 60 lines (62-121). Within the budget but doing four phases in one function: plan, conflict-detect, mkdir+read, write+backup+lockfile-update. Could be split, but the locality is also valuable when reading.
- **No rollback semantics** if a write fails partway through `applyManifest`. After the loop has written 3 of 5 files and the 4th errors, the disk is left in a half-applied state and the lockfile has been mutated for files 1-3 but not yet persisted (caller calls `writeLockfile` after `applyManifest` returns successfully — see cli.ts:284). The `result.backups` list is the only recovery hint, and it's only complete on success. This is acknowledged elsewhere in ccpp (the `.bak.<ts>` files are the recovery story), but it is **not** transactional.
- `backupStamp()` (line 250-252) — `new Date().toISOString().replace(/:/g, '-')`. Fine, but two backups inside the same millisecond would collide (and `fs.rename` would silently overwrite the older `.bak`). Unlikely in practice; worth a `Date.now() + counter` or random suffix for safety.
- `pathExists` (line 258-265) is duplicated in `manifest.ts:314-321` byte-for-byte. Should live in `fsutil.ts`.
- `buffersEqual` (line 254-256): redundant — `Buffer.equals` already short-circuits on length mismatch internally. Either inline `a.equals(b)` or document why the explicit length check is kept (microbench? early return without the C++ call?).
- Magic strings `'commands'`, `'skills'`, `'agents'` (lines 175, 209, 226) for the destination subdirs are hard-coded in three places. A `const CLAUDE_DIRS = { commands: 'commands', skills: 'skills', agents: 'agents' }` (or a typed union) would let the layout change in one place. They are also implicit in `cli.ts:728-730` for the inverse listing — same magic-string risk.
- The `// Incoming source explicitly preferred → overwrite.` comment at line 79 with no body is a *deliberately empty branch* — clear, but easy to miss. A `/* fallthrough */` comment-as-statement is unusual; the explicit branch is fine, just visually odd.
- `lockEntry` (lines 241-248) is small and pure but only used inside `applyManifest`; could be inlined or kept — neither is wrong.

### Style
- Doc-comments on the public exports (lines 56-61, 123-127) are excellent — they call out the non-destructive contract and the always-backup invariant.
- The internal-helper signatures repeat the `(items, seenDests, opts, X)` parameter tuple three times (lines 169, 203, 220). Could be a small `class Planner { items; seenDests; opts; pushCommand(c); pushAgent(a); pushSkill(s); }` for less typing, but the current form is also clear.
- `result.conflicts.push({ destPath, currentSourceUrl: existingEntry.sourceUrl, incomingSourceUrl: opts.sourceUrl, name: item.name })` (lines 84-89) — clean shape, matches the `Conflict` type. No silent mutation.

## Specific issues
- `src/lib/installer.ts:62-121` — `applyManifest` has no rollback. If write N of M throws, files 1..N-1 are on disk, the in-memory lockfile reflects them, but the caller hasn't yet persisted the lockfile (cli.ts writes after the call returns). Recovery relies on backup files plus a hand re-run. Document this contract in the doc comment, or implement rollback (replay backups in reverse on failure).
- `src/lib/installer.ts:108` — `backupStamp()` collides on sub-ms double-backup. `fs.rename` over an existing path is a silent overwrite on POSIX, so the older `.bak` would vanish. Add a counter or random suffix.
- `src/lib/installer.ts:258-265` — `pathExists` duplicates `manifest.ts:314-321` byte-for-byte. Move to `fsutil.ts`.
- `src/lib/installer.ts:175, 209, 226` — string literals `'commands'`, `'skills'`, `'agents'` for the Claude home subdirs are hard-coded in three places (here) and three more in `cli.ts:728-730`. Centralise.
- `src/lib/installer.ts:62` — `applyManifest` ignores the `manifest.warnings` array entirely. Collisions inside a single source (`command-name-collision`, `agent-name-collision`) are surfaced by `parseManifest` but never propagated to the caller through `ApplyManifestResult`. The cli also does not log them (cli.ts:223-225 reads the manifest and never inspects `.warnings`). Either propagate via `ApplyManifestResult.warnings` or have `cli.ts` `console.warn` them after parse.
- `src/lib/installer.ts:74-92` — the conflict-resolution cascade has three branches: preferred=incoming (overwrite), preferred=existing (skip), neither (record conflict). What is missing: when `existingEntry` exists but **belongs to the same `sourceUrl`**, the branch is skipped entirely (line 76 condition). That's correct (no conflict — we own this file). But the path then falls through to line 94+ which **re-reads** the file and possibly creates a redundant backup if bytes differ. Intentional (handles upstream drift in same source) but worth an inline comment.
- `src/lib/installer.ts:128-151` — `removeFromLockfile` parameter is named `name` but is documented as "Source URL". Name mismatch makes call sites read oddly: `removeFromLockfile({ name: target, ... })` where `target` is a URL. Rename to `sourceUrl`.
- `src/lib/installer.ts:148` — `delete opts.lockfile.sources[target]` is unconditional. If a partial install left the source pin without any `installed` rows, this still cleans it up. Correct, but worth noting in the doc-comment that this **always** drops the source pin even if no files matched.
- `src/lib/installer.ts:254-256` — `buffersEqual` is a thin wrapper around `Buffer.equals`. `Buffer.equals` already does a length check internally; the explicit length test is redundant. Either inline or delete the wrapper.
- `src/lib/installer.ts:79` — empty branch with a comment-only body. Functional, but unconventional in TS — at least one linter might flag it. Consider `if (preferred === opts.sourceUrl) { /* fall through to write */ }` plus an `else if` chain, or inverting the condition.
- `src/lib/installer.ts:117` — when an incoming write succeeds, `lockfile.installed[destPath]` is unconditionally overwritten. Good: handles the same-source upgrade case. Fine: matches the test at installer.test.ts:241 (`sourceSha` advances to `sha-2`). Consider documenting in the `ApplyManifestResult` doc.
- The agent test at installer.test.ts:155 uses `await listDir(...)`, but `listDir` is defined in the same test file — it's not from the source. No issue, just confirming the test is self-contained and the agent path is round-tripped through the real `applyManifest`.

## Suggestions
- **[high]** Move `pathExists` to `src/lib/fsutil.ts` and import from both `installer.ts` and `manifest.ts`. Pure deduplication.
- **[high]** Centralise the Claude home layout strings: `export const CLAUDE_LAYOUT = { commands: 'commands', skills: 'skills', agents: 'agents' } as const` in `src/lib/types.ts` (or a new `src/lib/layout.ts`). Update `installer.ts:175, 209, 226` and `cli.ts:728-730`.
- **[high]** Propagate `manifest.warnings` through `ApplyManifestResult` (or have `cli.ts` log them right after `parseManifest`). Today they vanish silently between parse and apply.
- **[medium]** Document `applyManifest`'s non-transactional contract in its doc-comment: "On mid-loop failure, files already written remain on disk; backups are preserved; the lockfile is mutated up to the failure point and is **not** automatically rolled back." Either that, or implement rollback (rename `.bak` files back on failure).
- **[medium]** Rename `removeFromLockfile`'s `name` parameter to `sourceUrl` (line 35-36 type, lines 128-151 implementation). Matches how every caller uses it.
- **[medium]** Make `backupStamp` collision-proof: append a 4-char random suffix or use `Date.now()` + a process-local counter.
- **[low]** Delete `buffersEqual` (line 254-256); call `a.equals(b)` directly at line 103.
- **[low]** Replace the empty-body branch + comment at lines 78-79 with a structurally clearer expression: e.g. handle the "preferred=existing → skip" case first (early `continue`), let everything else fall through naturally.

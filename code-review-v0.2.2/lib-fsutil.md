# Module: src/lib/fsutil.ts

**LoC**: 95  •  **Test file**: yes — `src/lib/fsutil.test.ts` (104 LoC)  •  **v0.2.2 status**: heavily refactored

## Purpose
Filesystem utility surface for ccpp: a hardened source-side reader (`readFileSafe` — refuses symlinks, caps file size), an atomic JSON-style writer (`writeFileAtomic`), and a best-effort `pathExists` check. Three helpers, all of which are security- or durability-critical.

## Public surface
- Const: `DEFAULT_MAX_FILE_BYTES`
- Types: `ReadFileSafeOpts`
- Functions: `readFileSafe`, `writeFileAtomic`, `pathExists`

## Strengths
- v0.2.1 finding ("TOCTOU window between `lstat` and `readFile`") is **resolved**: `readFileSafe` now opens with `fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW` (line 37) and reads from the resulting fd. The kernel rejects the open with `ELOOP` if the final path component is a symlink — single atomic syscall, no race.
- v0.2.1 finding ("no size cap — multi-GB blob OOMs the process") is **resolved**: `DEFAULT_MAX_FILE_BYTES = 50 MB` (line 8) and the cap is enforced **on the open fd via `fd.stat()`** (line 49), not a fresh `stat(path)` — same inode the read operates on, so the size cannot drift between check and read. This matches the brief's correctness ask.
- v0.2.1 finding ("`pathExists` duplicated") is **resolved**: `pathExists` lives here (lines 88–95), consumed by `git.ts`, `installer.ts`, `diff.ts`. Single home.
- v0.2.1 finding ("`writeJsonAtomic` belongs here") is **resolved**: `writeFileAtomic` (lines 75–85) is the single primitive for `lockfile.ts`, `config.ts`, and `claudeSettings.ts`. Random-suffix temp filename (line 76) prevents collisions when two ccpp runs interleave.
- The symlink-rejection error message (line 41) reads "Refusing to read symlink: …" — same prefix shape as v0.2.1's lstat-style message ("ccpp does not follow symlinks from source repos…"). The brief asked for this match for user diagnosis continuity; it's preserved. Tests at `fsutil.test.ts:25` and `:35` check `/refusing to read symlink/i` and pass against either implementation.
- The `try { fd.open } finally { fd.close().catch(() => {}) }` pattern (lines 36–58) is correct fd hygiene; close errors are swallowed because the read result is what callers want.

## Concerns
### Cohesion
Three helpers, all "filesystem utilities". The grouping is coherent (read, write, exists). Module is now ~3x larger than v0.2.1's single-helper version, but each function is small and self-contained.

### Coupling
- Imports `node:crypto`, `node:fs`, `node:path`. Stdlib only.
- Consumers: `git.ts`, `diff.ts`, `installer.ts` (readFileSafe + pathExists), `lockfile.ts`, `config.ts`, `claudeSettings.ts` (writeFileAtomic). Right boundary — every fs-dangerous operation routes through here.

### Maintainability
- `readFileSafe` (lines 33–59): 27 lines, 1 fd open, 1 stat, 1 read, 1 close. End-to-end readable.
- `writeFileAtomic` (lines 75–85): 11 lines including cleanup on failure. Good.
- The `await fd.close().catch(() => {})` (line 57) is correct — never re-throw a close error and shadow a real read error.
- Error message text on line 41 is long (one template literal, ~200 chars). It explains the threat model in user-facing terms; appropriate for a security-critical refusal.
- `writeFileAtomic` accepts `string | Buffer` (line 75) — flexible. The temp filename suffix uses `randomBytes(4).toString('hex')` (8 hex chars) — collision space is 2^32, more than enough for a single-user CLI.

### Style
- Doc comments on `readFileSafe` (lines 15–32) and `writeFileAtomic` (lines 61–74) are exceptional — both name the threat / failure mode, the syscall they use, and why the choice is right. Excellent reference for the rest of the lib.
- `DEFAULT_MAX_FILE_BYTES` (line 8) is exported with rationale ("50 MB — generous for any Claude Code skill/command/agent file shape, defensive against an adversarial source committing a multi-GB blob"). Good.
- No emojis, no TODOs, no dead code.

## Specific issues
- `src/lib/fsutil.ts:41` — error message no longer says "ccpp does not follow symlinks from source repos…" verbatim, but starts with "Refusing to read symlink:" which the v0.2.1 tests already match against (`/refusing to read symlink/i`, `fsutil.test.ts:31`). Continuity preserved. (Brief asked us to verify this — confirmed.)
- `src/lib/fsutil.ts:57` — `fd.close().catch(() => {})` swallows close errors silently. Correct under the "don't shadow read errors" principle, but worth one inline comment if anyone ever wonders why it's not awaited normally.
- `src/lib/fsutil.ts:79` — `fs.writeFile(tmp, content)` does not call `fsync` before `rename`. On some filesystems / power-loss scenarios this means the rename is durable but the data may not be on disk yet. For ccpp's use case (lockfile / settings, not financial state) this is acceptable; worth a one-line note in the doc comment that the atomic guarantee is process-crash, not power-loss.
- `src/lib/fsutil.ts:75–85` — `writeFileAtomic` does not fsync the parent directory after rename. Same comment: process-crash atomic, not power-loss.
- `src/lib/fsutil.ts:33` — `readFileSafe` has no equivalent for an `ENOTDIR` (path goes through a non-directory) error case. Today the `O_NOFOLLOW` open just returns the underlying errno; the caller sees a less-friendly error than the symlink case. Marginal — the manifest walker filters via `Dirent.isFile()` upstream, so this path is not normally reachable.

## Suggestions
- **[low]** Add a one-line doc note that `writeFileAtomic` is crash-atomic (rename on the same filesystem) but not durable across power loss without an explicit fsync. Document; don't add fsync — the cost would be real and the use case doesn't need it.
- **[low]** Add an inline comment on line 57 explaining why close errors are swallowed (so future readers don't "fix" it).
- **[low]** Optional test for `O_NOFOLLOW` against a path whose final segment is a *directory* symlink (versus the file symlinks already covered). Marginal coverage gain.

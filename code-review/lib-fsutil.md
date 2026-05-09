# Module: src/lib/fsutil.ts

**LoC**: 25  •  **Test file**: yes — `src/lib/fsutil.test.ts` (51 LoC)

## Purpose
A single-purpose security helper: read a file's bytes, but refuse if the path is a symlink. Used on the *source* side of the install pipeline, where a malicious source repo could plant a symlink pointing at `~/.ssh/id_rsa` or `/etc/passwd` and trick ccpp into copying its contents into `~/.claude/`.

## Public surface
- Function: `readFileSafe(path: string): Promise<Buffer>`

## Strengths
- The threat model and rationale are documented in detail (lines 3-15) — including *why* it's belt-and-suspenders (the manifest walker already filters via `Dirent.isFile()`) and *what* TOCTOU window it closes.
- Uses `lstat` not `stat` (line 18) — correctly stops at the symlink rather than dereferencing.
- Error message names the offending path (lines 20-22) and explains the reason in user-facing terms ("ccpp does not follow symlinks from source repos") — not a stack trace, an explanation.
- The companion test file (`fsutil.test.ts`) covers regular files, file symlinks, dangling symlinks, dir symlinks, and ENOENT — every distinct outcome of `lstat` is exercised.
- Tracked back to a real-world fix (CHANGELOG 0.1.2) — this isn't speculative hardening, it's documented mitigation.

## Concerns
### Cohesion
Single-purpose. The name `fsutil` suggests a grab-bag, but the file is just one function — that's a feature, not a bug, given the security-critical nature.

### Coupling
- Imports `node:fs/promises` only.
- Two callers: `installer.ts:98` (write path) and `diff.ts:61` (dry-run path) — both source-side reads. Correct boundary.

### Maintainability
- 7 lines of actual code. There's nothing to maintain.
- The TOCTOU window is *narrowed* but not eliminated: `lstat` on line 18, then `fs.readFile` on line 24 — between those two syscalls, an adversary with write access to the source dir could swap the regular file for a symlink. In practice the adversary is the source-repo author, who controls the dir contents at clone time but not at the millisecond between lstat and read. To fully close the window, `open(path, O_NOFOLLOW)` and read from the fd would be airtight. Node's `fs.open` exposes `O_NOFOLLOW` via `constants.O_NOFOLLOW`. Not urgent (the present `lstat` check is the same pattern git itself uses) but worth noting.
- No size guard. A multi-gigabyte file in a malicious repo would happily be slurped into a Buffer and then compared in `diff.ts:64` or written in `installer.ts:111`. A practical safety check (e.g. refuse files > 50MB) would protect against pathological inputs. Today the manifest walker doesn't filter by size either, so this is a pipeline-level concern, but `readFileSafe` is a natural place to enforce it.

### Style
- Excellent docstring (lines 3-16).
- The error message text is one long template literal; it's ~150 chars. Fine for a CLI; on a 80-column terminal it wraps once. Acceptable.
- No emojis, no TODOs, no dead code.

## Specific issues
- `src/lib/fsutil.ts:17-25` — TOCTOU window between `lstat` and `readFile`. Hardening with `O_NOFOLLOW` would close it. Low priority; the adversary model doesn't easily exploit a sub-millisecond race in a fresh clone.
- `src/lib/fsutil.ts:24` — no size cap. A maliciously large file (e.g. 10GB sparse file expanded by git) would OOM the process. Add an optional `maxBytes` param or a hard ceiling.
- `src/lib/fsutil.ts` — `pathExists` is duplicated in `git.ts:164-171` and `diff.ts:146-153`. This module is the natural home; pull it in.
- `src/lib/fsutil.ts` — `writeJsonAtomic(path, content)` (write-tmp + rename) belongs here too; `lockfile.ts` and `config.ts` both currently do non-atomic writes (see those reviews).

## Suggestions
- **[medium]** Add an optional `maxBytes` parameter to `readFileSafe` (default e.g. 50 MB) and reject larger files with a clear error. Exact size is a policy choice; the point is to have one.
- **[medium]** Move `pathExists` here (used by both `git.ts` and `diff.ts`).
- **[medium]** Add a `writeJsonAtomic(path, content)` helper here for `lockfile.ts` / `config.ts` to consume.
- **[low]** Replace the `lstat` + `readFile` pair with `fs.open(path, O_RDONLY | O_NOFOLLOW)` + read-from-fd to fully close the TOCTOU window. Defer until there's a documented exploit path.
- **[low]** Add a test case for a file made of all-zero bytes (sanity) and for a file >Buffer.kMaxLength (currently it would reject with a Node error — fine, but should be documented).

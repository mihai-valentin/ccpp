# Module: src/lib/git.ts

**LoC**: 214  •  **Test file**: yes — `src/lib/git.test.ts` (167 LoC)

## Purpose
Wraps the `git` CLI for ccpp's clone-or-update flow against a content-addressed cache (`<root>/<host>/<owner>/<repo>`). Owns URL parsing, cache path computation, the recently-extended SHA-aware checkout path, and a single `runGit` argv-spawn primitive shared by all callers.

## Public surface
- Types: `ParsedRepoUrl`, `CloneOrUpdateOptions`, `CloneOrUpdateResult`
- Functions: `parseRepoUrl`, `defaultCacheRoot`, `cachePathFor`, `cloneOrUpdate`, `clearCache`, `runGit`

## Strengths
- Uses `spawn` with explicit argv — no shell expansion, no quoting bugs. The `--` separator on `git clone` (line 103) keeps SCP-style URLs starting with `-` from being mistaken for flags.
- Hardens the spawn env against interactive auth: `GIT_TERMINAL_PROMPT=0` plus `GIT_ASKPASS=echo` (lines 188-189) — the test at `git.test.ts:152-166` even pins this behaviour.
- Cache layout (`host/owner/repo`) is purely derived from `parseRepoUrl`, so two URLs that resolve to the same logical repo land in the same cache dir (test at `git.test.ts:61-72`).
- Errors capture both the failed argv and the tail of stderr/stdout (lines 207-211), giving callers actionable failure messages without leaking process internals.

## Concerns
### Cohesion
The module is doing two distinct jobs: URL parsing (lines 6-71) and process orchestration (lines 73-214). They're related but separable — `url.ts` exists explicitly for URL handling and could absorb `parseRepoUrl` / `splitOwnerRepo` / `stripDotGit`. The current split is historically defensible (parsing existed before `url.ts`) but is now an organic seam.

### Coupling
- Stdlib-only (`node:child_process`, `node:fs`, `node:os`, `node:path`) — clean.
- `runGit` is exported (line 182) and used by tests directly; nothing else imports it externally. That's fine but the export-for-test pattern is slightly leaky.
- No back-coupling to types.ts or other lib modules — good. `cachePathFor` is the only piece other modules touch, and it does pure path math.

### Maintainability
- `cloneOrUpdate` (lines 84-123) is the highest-risk function: 4 branching paths (fresh vs cached × SHA vs branch). The comment at lines 91-94 explains *why* `--depth 1 --branch` can't carry a SHA but the actual control flow is dense. A short ASCII state diagram or a 2x2 table-driven dispatch would help.
- `looksLikeSha` (line 125-127) is a 4-40 hex regex. Branch/tag names are *also* allowed to be hex (e.g. someone could tag a release "deadbeef" or have a branch literally named `abcdef1`). The function is best-effort by name, but the consequence of a wrong guess is that the user passes `--ref deadbeef` meaning a branch and ccpp does a non-shallow clone + `git checkout deadbeef` (no `origin/` reset, line 115). That's still correct git behaviour but gives a different result than the user expected. Worth documenting the heuristic explicitly.
- `resolveDefaultBranch` (lines 140-153) regex-parses `git remote set-head` output (line 149) — this is fragile to git i18n (LANG/LC_ALL) and to git version drift in the wording. Setting `LC_ALL=C` in the spawn env (alongside the `GIT_*` knobs at line 186-190) would harden it.
- `pathExists` (lines 164-171) is duplicated in `diff.ts:146-153` byte-for-byte. Pull it into `fsutil.ts`.
- Magic strings: the cache subdir component `'.ccpp/cache'` (line 76) is computed by `join` — fine. But the env var name `CCPP_CACHE` is duplicated implicitly in user-facing docs; centralizing env-var names in one place would help.
- `runGit` returns `{ stdout, stderr }` but on exit code 0 the stderr is silently discarded by every caller. Most git operations write progress to stderr — if a caller wanted to log it, they'd have to call `runGit` directly. Today no caller wants that, so it's a latent feature, not a bug.

### Style
- The mixed naming (`opts.ref`, `parsed`, `scp`, `e`, `obj`) is consistent with the rest of the codebase but `scp` (line 35) deserves a comment — readers unfamiliar with git URL forms won't recognize "scp-style" as "OpenSSH legacy URL".
- `// @-style` non-null assertions (`scp[2]!`, `scp[3]!`, lines 36-37, also `match[1]!` at line 150) — fine here since the regex shape guarantees the captures, but worth a short comment justifying each.
- The interface ordering is good: types first, then exports in dependency order.

## Specific issues
- `src/lib/git.ts:95` — `looksLikeSha` is a heuristic that misclassifies short-but-real branch names (`abc1` would be treated as a SHA). The user can disambiguate via `--full-clone`, but the silent path divergence is invisible.
- `src/lib/git.ts:114` — `git checkout <ref>` with detached HEAD on a SHA leaves the cache repo in a "detached HEAD" state. Re-running with a branch ref later will re-attach via line 117's reset, but interleaved invocations between two refs on the same cache dir create a non-obvious `ORIG_HEAD` history. Not a bug today but worth noting.
- `src/lib/git.ts:140-153` — `resolveDefaultBranch` parses `git remote set-head --auto` *output* with `\bset to (\S+)/`. If git is localized (LANG=de_DE), this returns no match and throws "Could not determine default branch". Add `LC_ALL: 'C'` to the env (line 186-190).
- `src/lib/git.ts:99` — `fs.mkdir(join(localPath, '..'), { recursive: true })` creates the *parent*; OK, but on Windows this also handles the drive letter case; it's a small foot-gun if `localPath` is a relative path that traverses up. `cachePathFor` always returns absolute, so safe today, but a defensive `resolve()` at clone time would document that intent.
- `src/lib/git.ts:164-171` — `pathExists` duplicates `diff.ts:146-153`. Move to `fsutil.ts`.
- `src/lib/git.ts:182` — `runGit` is exported solely for the test at line 160. Consider keeping it internal and exposing a thin test-only entry point, or document the public-API status of this export.
- `src/lib/git.ts:202` — error wrapping `Failed to spawn git: ${err.message}` discards the original `err.code` (e.g. `ENOENT` when git isn't on PATH). Wrapping with `cause: err` (Error options) preserves it.
- `src/lib/git.ts:108` — `git fetch --unshallow` only works *the first time*. If the cache is already deepened and a second SHA is requested, this command fails. Today guarded by `await isShallowRepo(localPath)` so it's correct; just noting the brittleness.
- No injection risk via argv — confirmed. Even a malicious `ref` like `--upload-pack=evil` is positional after `--branch` and isn't re-interpreted, since spawn doesn't invoke a shell. Good.

## Suggestions
- **[high]** Add `LC_ALL: 'C'` to the spawn env at line 186-190 to make `resolveDefaultBranch`'s regex parse robust across locales.
- **[high]** Document `looksLikeSha`'s heuristic limitation at the function and at the `--ref` flag's user-facing help: "if your branch/tag name happens to look like a hex SHA, pass `--full-clone`".
- **[medium]** Extract `pathExists` into `fsutil.ts` (also used by `diff.ts`).
- **[medium]** Wrap spawn errors with `cause: err` (line 202) so `ENOENT git not found` is not flattened into a string.
- **[medium]** Replace the `cloneOrUpdate` 4-branch flow with a tiny state object: `{ kind: 'fresh-branch' | 'fresh-sha' | 'cached-branch' | 'cached-sha' }` computed up front, then a switch. Easier to test and read.
- **[low]** Add a one-line comment at line 35 explaining the SCP-style URL grammar.
- **[low]** Consider moving `parseRepoUrl` and friends to `url.ts` so this module is purely about process orchestration. Defer if it would churn callers — the boundary is clean enough as-is.

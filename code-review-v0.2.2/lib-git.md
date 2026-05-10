# Module: src/lib/git.ts

**LoC**: 242  •  **Test file**: yes — `src/lib/git.test.ts` (214 LoC)  •  **v0.2.2 status**: refactored

## Purpose
Wraps the `git` CLI for ccpp's clone-or-update flow against a content-addressed cache (`<root>/<host>/<owner>/<repo>`). Owns URL parsing (`parseRepoUrl`), cache path computation, the SHA-aware checkout path, and the single `runGit` argv-spawn primitive. v0.2.2 replaces the old hex-shape SHA heuristic with an authoritative `ls-remote` probe.

## Public surface
- Types: `ParsedRepoUrl`, `CloneOrUpdateOptions`, `CloneOrUpdateResult`
- Functions: `parseRepoUrl`, `defaultCacheRoot`, `cachePathFor`, `cloneOrUpdate`, `clearCache`, `runGit`

## Strengths
- v0.2.1 finding #1 ("`looksLikeSha` heuristic mis-classifies hex-shaped branch names") is **fully resolved**. `isNamedRefRemote` (lines 145–160) asks `git ls-remote --exit-code` whether the ref exists as a branch or tag and treats only exit code 2 as "not a named ref" — every other failure (auth, DNS, repo-not-found) re-raises. The reasoning is laid out at lines 95–105 and 137–143, which is exactly what the v0.2.1 review asked for.
- v0.2.1 finding ("`resolveDefaultBranch` regex is locale-dependent") is **resolved**: `LC_ALL: 'C'` and `LANG: 'C'` are pinned in the spawn env (lines 215–217) with an inline comment naming the matcher that depends on it.
- v0.2.1 finding ("spawn errors lose `err.code`") is **resolved**: `child.on('error', …)` now wraps with `{ cause: err }` (line 230), so an `ENOENT git not found` propagates structurally instead of being flattened to a string.
- `pathExists` was deduplicated into `fsutil.ts` and is imported (line 5) — v0.2.1 finding resolved.
- The `--` separator on clone arguments (line 114) still defends against URLs starting with `-`.

## Concerns
### Cohesion
Still mixes URL parsing (lines 28–75) with process orchestration (lines 88–242). The boundary is the same as v0.2.1 and the v0.2.1 reviewer judged this acceptable; nothing in v0.2.2 makes it worse. `url.ts` exists for the shorthand parser and could absorb `parseRepoUrl` if future cleanup wants to draw a hard line, but no churn is justified just for that.

### Coupling
- Imports `node:child_process`, `node:fs`, `node:os`, `node:path`, plus `pathExists` from `./fsutil.js` (line 5) — clean.
- `runGit` is still exported (line 206); `git.test.ts` consumes it directly. Same export-for-test pattern as v0.2.1 — no new leak.
- No back-coupling to `types.ts` or other lib modules.

### Maintainability
- `cloneOrUpdate` (lines 88–134) is now driven by `refIsSha` once at the top (line 106) and the four-branch flow reads naturally; no follow-up state-machine refactor is needed.
- The `isNamedRefRemote` exit-code parser (line 157) inspects the *string* rendered by `runGit`'s rejection (`/failed \(exit 2\)/`). This is internal-to-this-file (the exact format is set at line 238) but it is implicit-coupling between two functions in the same module — if `runGit`'s message format ever changes, `isNamedRefRemote` silently degrades to "always re-throw" and every named ref will be treated as a SHA. A typed error (`class GitExitError extends Error { code: number }`) would be sturdier; cite as a low-priority polish item.
- `isNamedRefRemote` issues an extra round-trip per `cloneOrUpdate` call when `opts.ref` is set. For a CLI invoked once per sync, the cost is invisible. Worth flagging only if a future feature loops over many refs.
- Magic string `.ccpp/cache` is still computed by `join(homedir(), '.ccpp', 'cache')` (line 80) — fine. The env var name `CCPP_CACHE` (line 78) is duplicated implicitly across the docs; centralizing env-var names in one constants file remains a deferred cleanup.
- `runGit` returns `{ stdout, stderr }` but on success no caller reads `stderr`. Latent feature, not a bug.

### Style
- Doc comments are dense and clear: lines 95–105 (cloneOrUpdate decision rationale), 136–144 (isNamedRefRemote contract). Excellent — the kind of comments a reader looking for "why" actually wants.
- Inline regex comment on line 38 explains the SCP-style group capture (resolves the v0.2.1 "scp identifier deserves a comment" nit).
- Naming and type discipline consistent with the rest of the codebase.

## Specific issues
- `src/lib/git.ts:157` — `isNamedRefRemote` matches `/failed \(exit 2\)/` against `runGit`'s string-formatted error message (line 238). Tight implicit coupling between two private code paths in the same module. A typed `GitExitError` carrying `exitCode` would be sturdier; today the test at `git.test.ts` exercises the happy path but a future reformat of the error string would silently break ref classification.
- `src/lib/git.ts:106` — every named-ref clone now pays one extra `git ls-remote` round trip (vs. the old regex that was free). For ccpp's once-per-sync invocation, irrelevant. Worth noting only if future commands batch many lookups.
- `src/lib/git.ts:181–185` — `resolveDefaultBranch` still does fallback regex parsing of `git remote set-head --auto` output; with the new `LC_ALL=C` pin this is robust. The latent fragility (git version drift in the wording) remains, but is unrelated to v0.2.2 changes.

## Suggestions
- **[low]** Consider replacing the message-regex coupling in `isNamedRefRemote` with a typed `GitExitError` carrying `exitCode: number`. Two-line change to `runGit`, makes the classifier robust to error-message wording.
- **[low]** No-op refactor candidate (defer): co-locate `parseRepoUrl` / `splitOwnerRepo` / `stripDotGit` into `url.ts` so this module is purely process orchestration. Don't churn just for it.

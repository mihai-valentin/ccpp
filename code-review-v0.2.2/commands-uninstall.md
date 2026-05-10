# Module: src/commands/uninstall.ts

**LoC**: 84  •  **Test file**: no — there is no `commands/uninstall.test.ts`. `resolveSourceForUninstall` is exported but uncovered by direct unit tests.  •  **v0.2.2 status**: new (extracted from cli.ts)

## Purpose
Implements `ccpp uninstall <name>`. Maps a user-supplied identifier (full URL, repo basename, or matching sourceUrl) to a canonical lockfile source URL, then drops every file installed from that source (renamed to `.bak.<ts>`), removes its lockfile entries, and prunes it from `ccpp.config.json` if present.

## Public surface
- `RunUninstallOpts` (line 10) — extends `ResolvedCommon` with `name: string`.
- `runUninstall(opts)` (line 20) — async void; throws `UserError` for missing name / unreadable lockfile / no-match.
- `resolveSourceForUninstall(lockfile, name)` (line 69) — pure resolver; returns canonical URL or `null`.

## Strengths
- Tight (84 LoC), single responsibility, IO/pure split. `resolveSourceForUninstall` is a pure function over the lockfile; the IO wrapper is a thin shell.
- Three-step resolution policy in `resolveSourceForUninstall` (70–83) is clearly ordered: (1) exact URL match in `lockfile.sources`, (2) repo basename match via `parseRepoUrl`, (3) sourceUrl match in `lockfile.installed` entries. Each step has a justification.
- The `try/catch` around `parseRepoUrl` (lines 73–77) correctly tolerates malformed URLs in the lockfile so they don't block uninstalling a different source by name. The comment at 76 names this rationale — addresses the v0.2.1 finding that asked for an explanatory comment.
- Files are renamed, not deleted. `removeFromLockfile` from `lib/installer` does the work (line 35). Recovery is always possible — a real safety property worth preserving.
- Config pruning is conditional on a real change (lines 44–48) — `writeConfig` is only called when the source list actually shrank. Avoids spurious lockfile churn.
- Doc comments cover both the function-level contract (15–19, 64–68) and field-level detail on `RunUninstallOpts.name` (line 11). 

## Concerns

### Cohesion
Excellent. Two functions, one feature.

### Coupling
- Imports `lib/config`, `lib/errors`, `lib/git` (just `parseRepoUrl`), `lib/installer` (just `removeFromLockfile`), `lib/lockfile`, `lib/term`, `lib/types`, and `commands/shared`. All necessary.
- No coupling into other `commands/*` siblings.

### Maintainability
- The order of operations in `runUninstall` (lines 35–51) is: removeFromLockfile (file moves + lockfile object mutation) → readConfig → write config if changed → writeLockfile. The lockfile is mutated by `removeFromLockfile` *in place* (line 35–39) but persisted only at line 51. If `readConfig` or `writeConfig` throws between lines 42 and 51, the on-disk lockfile won't reflect the in-memory mutation — but the files have already been renamed to `.bak.<ts>`. Recovery is possible (the backups exist, the file paths are still present in the lockfile), but the on-disk state is briefly inconsistent. Worth either persisting the lockfile *first* (right after `removeFromLockfile`, before the config touch) or wrapping the config step in a try/catch that still flushes the lockfile.
- `await readConfig(opts.configPath).catch(() => null)` (line 42) silently swallows every error — including filesystem permission errors and JSON parse errors. The `null` then gates the config-pruning branch (lines 43–49). If the user's config is corrupt, `ccpp uninstall foo` will succeed with no prune and no warning. A `UserError` on parse failure (mirroring `runInstall`) would be more honest.
- `if (typeof opts.name !== 'string' || opts.name.length === 0)` (line 21) is a runtime check on a parameter typed as `string` (line 12). Defensive, but if cac validates `<name>` as required, the check is unreachable — and if cac doesn't, the tighter type is wrong. Either is fine; pick one stance.
- `resolveSourceForUninstall` (69–84) returns `null` for no-match. The caller turns it into a `UserError` with a hint pointing at `ccpp list` (lines 30–32). Two-step "return null + caller throws" is fine; consider whether the resolver should just throw (less ceremony at the call site) — minor stylistic call.
- The third resolver branch (lines 80–82) loops over `Object.values(lockfile.installed)` and returns `entry.sourceUrl` of the first matching one. If multiple entries share a sourceUrl (which is the normal case — every file from the same source has the same sourceUrl), it returns on the first hit. Correct but a comment naming "any matching entry will do because all entries from the same source share the URL" would help.

### Style
- Naming is consistent.
- The `catch (err: Error)` typing (line 24) lines up with the rest of the codebase.
- Direct `process.stdout.write` for JSON (line 54) — same convention as init/list/install. Same comment-once-centrally suggestion applies.
- The `for...of Object.keys(...)` (line 71) and `for...of Object.values(...)` (line 80) pair is consistent with the rest of the codebase's lockfile-iteration style.

## Specific issues
- **commands/uninstall.ts:35–51** — non-atomic operation order. Files are renamed before either the config or the lockfile is persisted; an exception in the middle leaves disk state inconsistent (files moved, lockfile not yet rewritten). Persist the lockfile right after `removeFromLockfile` returns, before touching the config.
- **commands/uninstall.ts:42** — `readConfig(...).catch(() => null)` swallows all errors. Filesystem-permission and JSON-parse errors should not silently disable config pruning. Mirror `runInstall`'s behaviour and throw `UserError` on real parse failures, only swallowing "file not found".
- **commands/uninstall.ts:21–23** — runtime check on a parameter typed as required `string` is either dead or defensive. Pick a stance (use `string | undefined` if cac can leave it absent).
- **commands/uninstall.ts:80–82** — the "any installed entry's sourceUrl" fallback is correct but the loop's intent (any-match suffices because installed entries from one source all share the URL) deserves a one-line comment.
- **commands/uninstall.ts:69** — `resolveSourceForUninstall` is exported but has no unit test. The three-branch resolver is a textbook unit-test target — full URL match, basename match, fallback match, no-match.
- **commands/uninstall.ts:54** — `--json` write bypasses `log()`/`opts.quiet`. Same cross-file convention worth one central comment.

## Suggestions
- **[medium]** Reorder persistence in `runUninstall` so the lockfile is written before the config is touched. Reduces the inconsistent-state window if the config write fails.
- **[medium]** Stop swallowing all `readConfig` errors at line 42. Distinguish "file missing" (silent, expected) from real parse/permission failures (throw).
- **[medium]** Add `commands/uninstall.test.ts` covering all four branches of `resolveSourceForUninstall`, and an integration-style test for the persistence order in `runUninstall`.
- **[low]** Comment lines 80–82 to name the "any installed entry suffices" invariant.
- **[low]** Decide whether the runtime nullness check at line 21 is dead or needed; tighten or remove accordingly.

## Resolved from v0.2.1
- `resolveSourceForUninstall` is now in its own module — extracted from cli.ts.
- Comment on the `parseRepoUrl` swallow (line 76) addresses the v0.2.1 "worth a comment beyond ignore parse failures" finding.
- Config-mutation pattern (line 45–48 — `filter` then `writeConfig` only on actual change) is locally fine and now isolated in a uninstall-only file rather than mixed in with other handlers.

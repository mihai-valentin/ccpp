# Module: src/commands/sync.ts

**LoC**: 413  •  **Test file**: yes — `src/commands/sync.test.ts` (293 LoC, 12 cases driven by a real `LocalGitFixture`).

## Purpose
Implements the `ccpp sync` subcommand: for every source in `ccpp.config.json`, clone-or-update, compute a changeset against the on-disk `~/.claude/` state, route through the apply gate (autoAccept / TTY prompt / non-TTY skip / JSON mode), apply the manifest if approved, and write a structured `sync.log` entry. Surfaces the `SyncReport` shape consumed by the CLI presenter and the JSON output.

## Public surface
- **Types**:
  - `SyncOverride` (alias of `SyncPolicy`).
  - `SyncOverrideFlags` — the three CLI flags `--prefer-latest`, `--pinned`, `--update`.
  - `ApplyStatus` — `'applied' | 'no-changes' | 'skipped-no-prompt' | 'user-declined'`.
  - `RunSyncOpts`, `SourceSyncReport`, `SyncReport`.
- **Functions**:
  - `resolveOverride(flags): SyncOverride | undefined` — flag → policy collapse, throws on `--prefer-latest + --pinned`.
  - `effectivePolicy(source, config, override): SyncPolicy` — three-tier precedence (override > per-source > global > pinned).
  - `runSync(opts): Promise<SyncReport>` — the main entry.

## Strengths
- The apply gate is decision-tabled in the doc comment (lines 121–135) and matches the implementation in `decideApply` (354–367) line-for-line. The logic and its rationale are co-located and verifiable.
- DI hooks for testability are first-class: `confirm` (lines 60–64) and `isTTY` (lines 65–69) are plumbed through `RunSyncOpts` so the test file drives every branch in-process. Test cases DA1–DA5 (sync.test.ts:144–253) cover all four `ApplyStatus` values without spawning a subprocess.
- `effectivePolicy` (110–119) is a tiny pure function with five test cases (sync.test.ts:53–141) — exactly the right grain for the precedence rule.
- `runSync` writes the lockfile *once* at the end (line 327), regardless of per-source outcome. Correctness invariant: skipped sources retain their prior pin (lines 293–308), explicitly stated in the doc comment.
- `appendSyncLog` is called on every terminal outcome — error (174–183, 191–200), success (279–291), skip (314–323) — so the audit trail is complete. Trigger tagging (`'manual'` vs `'hook'`) is preserved.
- Skipped runs return exit 0 by design (line 134) — the doc comment explicitly says "hook-triggered syncs must never block a Claude Code session". Important UX contract, captured in code.

## Concerns

### Cohesion
The module does one thing — sync — but `runSync` itself is doing too much in one stack frame (see Maintainability). `formatCollisionMessage` (404–413) is a presentation helper and could move out, though it is small enough that staying here is defensible.

### Coupling
- Imports from six `lib/*` modules (lines 1–15). Appropriate for an orchestrating subcommand.
- Crucially, **error classes are duplicated from `cli.ts`** (lines 17–31). The `// Private error classes — the cli.ts classifier reads .exitCode by duck-typing` comment (line 17) acknowledges this is a workaround. The exit-code numerics are also hard-coded (`= 1`, `= 2`, `= 3`) instead of importing the `EXIT` map from `cli.ts`. If `cli.ts:EXIT.USER` ever changes, this file silently desyncs.
- `commands/sync.ts` does not import from `cli.ts` (correct — that would be circular), so the duplication is the cost of avoiding the circular import.
- Imports `promptYesNo` from `lib/term.ts` (line 14) and uses it as a fallback at line 366. The fallback path is the only branch not exercised by tests (because `confirm` is always passed). That is fine — the test-only path matters more — but worth noting.

### Maintainability
- `runSync` is 205 lines (136–340). The big middle section is a 162-line `for (const source of config.sources)` loop (162–325) with two large branches (apply at 229–291, skip at 292–324) plus a 32-line clone/manifest preamble per source (162–209). Three obvious extractions:
  1. `cloneAndParse(source, trigger, opts)` — wraps clone+manifest+error logging (lines 162–201).
  2. `applySource(source, manifest, synced, ...)` — the apply branch (229–291).
  3. `recordSkip(source, ...)` — the skip branch (292–324).
- The `appendSyncLog` calls are nearly-duplicated three times (174–183, 191–200, 314–323) — same struct shape, slightly different fields. Wrap as `logSyncOutcome(outcome, source, opts, extras)`.
- The `try { synced = await cloneOrUpdate(...) } catch (err) { await appendSyncLog(...); throw new EnvError(...) }` pattern (170–184) and its near-twin for `parseManifest` (186–201) repeat the same control-flow shape. A `withSyncLog(opts, source, trigger, fn)` higher-order helper would collapse both.
- `priorDests` derivation at lines 230–232 (filter lockfile entries by sourceUrl, then map to dest paths) is the kind of lockfile query that belongs in `lib/lockfile.ts` as `destinationsForSource(lockfile, url)`. Same pattern likely needed for uninstall (`cli.ts:711`).
- The "removed" derivation at line 250 (`priorDests.filter(p => !current.has(p))`) is correct but undocumented. A one-line comment would help: `// Files that existed before this sync but did not appear in the new manifest.`
- Magic strings: `.slice(0, 7)` for SHA truncation appears at lines 270, 271 — same constant as in `cli.ts`. Hoist a `SHORT_SHA_LEN`.
- The `if (!opts.quiet && !opts.json)` guard appears at lines 269 and 360 (twice in the same module). That is a frequent enough condition to warrant a `shouldEmitText(opts)` helper.
- Error-handling pattern is consistent within this file (`.catch((err: Error) => { throw new UserError(err.message); })`) at 137 and 152 — good. But it diverges from `cli.ts`'s mix of styles.

### Style
- `formatCollisionMessage` (404–413) is a sibling of the same-named function in `cli.ts:773–786` with a different signature. Pick one.
- `decideApply` (354–367) returns through five separate branches and is easy to read — well factored.
- `renderProposal` (369–382) builds a header + optional bullet list. Clean and pure. Easy to extend for, say, color highlighting if wanted later.
- `logSkip` (384–402) writes to `stderr` even when `--quiet` is on for the early-return guard at line 391. Wait — the early return at 391 (`if (opts.quiet) return;`) does prevent writes when quiet. Fine.
- `SourceSyncReport` (72–86) duplicates `installed/updated/unchanged/conflicts/backups` from the `applyManifest` result type. If `lib/installer.ts` exports the type, this could spread it: `Pick<ApplyResult, ...> & { url, policy, ... }`.
- Naming: `applyStatus` is good. `priorSha` / `sha` (current) is a bit terse — `previousSha` / `newSha` would self-document.
- `autoAcceptEffective` (line 159) is a reasonable name but the boolean coalescing `opts.autoAccept === true || config.autoAccept === true` is the kind of "is this autoAccept on right now" check that should live next to the config types — say `lib/config.ts:isAutoAcceptOn(config, override)`.

## Specific issues
- **commands/sync.ts:18–31**: error-class duplication of cli.ts:51–64. Extract to `lib/errors.ts` and import from both places.
- **commands/sync.ts:19, 22, 25**: hard-coded exit codes (1, 2, 3). Should reference an exported `EXIT` map.
- **commands/sync.ts:136–340**: `runSync` is 205 lines and does five distinct things (load config, load lockfile, per-source loop with two branches, finalize, optionally throw). Refactor into the three helpers named under Maintainability.
- **commands/sync.ts:174–183, 191–200, 314–323**: three near-identical `appendSyncLog` calls. Extract.
- **commands/sync.ts:230–232**: in-place lockfile query that should be a named helper in `lib/lockfile.ts`.
- **commands/sync.ts:240**: `config.preferredSources ?? {}` — same default as `cli.ts:231`. Centralize.
- **commands/sync.ts:270–271**: `.slice(0, 7)` magic constant.
- **commands/sync.ts:404–413**: duplicate of `cli.ts:773–786`.
- **commands/sync.ts:286–289**: spread-with-conditional-key (`...(result.conflicts.length > 0 && { error: ... })`) is idiomatic but obscure. A traditional `if` with an `if (result.conflicts.length > 0) entry.error = ...` is easier to read in this context. Minor.
- **commands/sync.ts:298**: `sha: priorSha ?? synced.sha` for the skip path — comment why we report `synced.sha` when there is no prior pin. Currently a reader has to reason about it.
- **commands/sync.ts test**: 30-second timeouts on every test (sync.test.ts:70, 87, etc.) suggest the local-git-fixture is slow on CI. Worth profiling whether the fixture can be cached across cases instead of recreated in `beforeEach`.

## Suggestions
- **[high]** Extract a shared `lib/errors.ts` with `UserError`, `EnvError`, `CollisionError`, and the `EXIT` constant. Both `cli.ts` and `commands/sync.ts` import from it. Drop the duck-typed exit-code reader in `cli.ts:classifyAndExit` in favor of `instanceof` after refactor.
- **[high]** Decompose `runSync` into `cloneAndParseSource`, `applySource`, `recordSkip`, and a `logSyncOutcome` log wrapper. Target ~60 lines for `runSync` itself.
- **[medium]** Move the lockfile-by-source-url query (line 230–232) into `lib/lockfile.ts` as `destinationsForSource(lockfile, url): string[]`.
- **[medium]** Consolidate `formatCollisionMessage` with the variant in `cli.ts:773–786`. Single signature: `formatCollisionMessage(conflicts, options?: { incomingSource?: string })`.
- **[medium]** Move `isAutoAcceptOn(config, opts)` and `effectivePolicy` (already here) into a `lib/policy.ts` module so the precedence + autoAccept logic is co-located and unit-tested as a unit.
- **[medium]** Replace the four `.slice(0, 7)` SHA truncations across cli.ts and sync.ts with a `formatShortSha(sha)` helper (likely in `lib/term.ts` or `lib/git.ts`).
- **[low]** Rename `priorSha`/`sha` to `previousSha`/`currentSha` in `SourceSyncReport` for self-documentation. Update call sites (small change, all internal).
- **[low]** Add a comment on the `priorDests.filter(p => !current.has(p))` line (sync.test.ts:250 — actually sync.ts:250) describing the "files removed from the manifest since last sync" intent.
- **[low]** Pin the `ApplyStatus` literal union to a const map (`APPLY_STATUS = { APPLIED: 'applied', NO_CHANGES: 'no-changes', ... }`) so callers can reference symbols rather than string literals; reduces typo risk for `JSON.stringify` consumers (none today, but eventually).

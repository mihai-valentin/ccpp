# ccpp — code review (v0.2.2)

Snapshot of the codebase taken at the v0.2.2 release point. This review is the **delta-check** of the v0.2.1 review at `../code-review/`: it verifies the nine high-severity findings landed cleanly, evaluates the new modules introduced by the refactor, and surfaces anything that should still be addressed before the GitHub repo is flipped public.

## TL;DR

ccpp v0.2.2 is **materially healthier than v0.2.1**. Every high-severity item from the previous review is closed; cli.ts shrank from 1093 → 388 LoC; six new lib modules and four new commands modules carve the codebase along clean responsibility lines; tests grew 213 → 246. The two-phase staging tree, ls-remote ref classification, atomic JSON writes, strict per-entry lockfile validation, and `O_NOFOLLOW`-based source reads are all in place.

The fresh review surfaced **one real bug** (cross-platform path matcher in `lib/layout.ts`) and a **handful of small carry-overs** worth fixing as polish. Nothing in this report blocks the OSS flip.

## Newly-found issues

These were **not** in the v0.2.1 review — found by re-reading the v0.2.2 codebase. Three are fixed in this commit; the rest are noted for follow-up.

| # | Finding | Files | Severity | Status |
|---|---|---|---|---|
| 1 | **Cross-platform path matcher** in `classifyDestination` hardcoded `/` in the prefix strings, so on Windows `ccpp list` and the install-wizard tally would silently classify everything as `null`. | `src/lib/layout.ts:42-44` | medium | **fixed in this commit** |
| 2 | Custom error classes did not forward `ErrorOptions` (the `cause: e` chain), silently dropping caught errors. | `src/lib/errors.ts` | low | **fixed in this commit** |
| 3 | `isIsoTimestamp` was duplicated byte-identically between `lib/config.ts` and `lib/lockfile.ts` (the helper added during the strict-validation work). Extracted to `lib/iso.ts`. | `src/lib/config.ts:5-10`, `src/lib/lockfile.ts:136-142` | low | **fixed in this commit** |
| 4 | `commands/uninstall.ts` renames files before rewriting the lockfile — an exception between the two leaves disk and lockfile inconsistent. The same staging-tree pattern used in `applyManifest` would close it. | `src/commands/uninstall.ts:35-50` | medium | open |
| 5 | `commands/list.ts:lockfileRows` synthesizes a per-skill `destPath` (the skill directory) instead of returning the per-file paths the lockfile actually tracks. Intentional but undocumented and surprising in `--json` output. | `src/commands/list.ts:79-83` | low | open |
| 6 | `commands/shared.ts:commonPaths` quietly calls `disableColor()` as a side effect when `--no-color` is set. Side effect inside what reads as a pure path-resolver. | `src/commands/shared.ts:57` | low | open |
| 7 | `commands/install.ts:installSource` (~100 LoC, four conflict branches) still has no direct unit tests despite being explicitly flagged in v0.2.1. | `src/commands/install.ts` | medium | open |
| 8 | `manifest.ts` carries **three** near-identical scanner wrappers (commands / skills / agents) and **three** near-identical collision detectors. v0.2.2 added a third copy of each for skills instead of generalizing the pair flagged in v0.2.1. | `src/lib/manifest.ts:193-243, 287-342` | medium | open |
| 9 | `commands/sync.ts` uses `Awaited<ReturnType<typeof cloneOrUpdate>>` as a pseudo-type in 4 places. A named `CloneResult` export from `lib/git.ts` would clean it up project-wide. | `src/commands/sync.ts` | low | open |
| 10 | `lib/claudeSettings.ts:readSettings` casts `JSON.parse(...) as ClaudeSettings` with no shape validation. A hand-edited malformed `~/.claude/settings.json` would surface as a downstream `TypeError`. | `src/lib/claudeSettings.ts` | low | open |
| 11 | `applyConfigSet` in `lib/config.ts` still prompts for risk acknowledgement before validating the value can be coerced (carry-over from v0.2.1 #20). | `src/lib/config.ts:applyConfigSet` | low | open |
| 12 | `commands/sync.ts` aggregates `appendSyncLog` calls in three call sites that still construct entries inline; only the error path got factored. | `src/commands/sync.ts` | low | open |
| 13 | `applyManifest` mutates `opts.lockfile.installed` for unchanged items in `preparePlan` *before* phase 2. The empty-`toWrite` short-circuit therefore is not a no-op against the lockfile. Worth documenting. | `src/lib/installer.ts:applyManifest` | low (doc) | open |
| 14 | `src/index.ts`'s `export type *` re-exports parser-internal types (`MarketplaceJson`, `PluginJson`); audit before public to avoid leaking implementation details. | `src/index.ts` | low | open |

## v0.2.1 findings re-verified

Spot-checks confirmed all nine high-severity v0.2.1 items are resolved:

| v0.2.1 # | Status in v0.2.2 |
|---|---|
| #1 — diff.ts agents | ✅ Both `installer.ts` and `diff.ts` now import the shared `planFiles` from `lib/plan.ts`; no second copy left. Round-trip test pins agents-as-`unchanged`. |
| #2 — manifest warnings dropped | ✅ Surfaced on stderr from both `commands/install.ts:installSource` (210-212) and `commands/sync.ts:cloneAndParseSource` (260-262). |
| #3 — non-atomic JSON writes | ✅ `writeFileAtomic` (temp + rename) used by `lockfile.ts`, `config.ts`, and `claudeSettings.ts:writeSettings`. |
| #4 — applyManifest rollback | ✅ Three-phase staging tree (`preparePlan` / `stagePlan` / `commitStaged`); phase-1 failure leaves `~/.claude/` untouched; phase-2 partial-failure documented. |
| #5 — standalone skills ignored | ✅ `scanStandaloneSkills` added to `manifest.ts`; `ResolvedManifest.standaloneSkills` wired through planner. |
| #6 — looksLikeSha heuristic | ✅ Replaced by `isNamedRefRemote` (`git ls-remote --exit-code`). Auth/network failures re-throw with diagnostics. |
| #7 — hook script parity | ✅ `install-hook.test.ts` pins executable lines of `HOOK_SCRIPT_BODY` against `scripts/hook.sh`. |
| #8 — config cwd-coupling | ✅ Resolution: `--config <path>` > `--project` > `./ccpp.config.json` (if exists) > `~/.ccpp/ccpp.config.json`. Hook auto-update flow now works regardless of Claude Code launch cwd. |
| #9 — install doesn't write config | ✅ `installSource` always writes a config when `!scratch` (was gated on `existing && !scratch`). |

## Cross-cutting refactors verified

| Refactor | Status |
|---|---|
| `lib/errors.ts` (UserError/EnvError/CollisionError + EXIT) | ✅ All 5 sites consolidated; `classifyAndExit` uses `instanceof`. |
| `lib/layout.ts` (CLAUDE_LAYOUT + classifyDestination) | ✅ Strings centralized, used by installer/diff/list/install-wizard. (Cross-platform bug fixed in this commit.) |
| `lib/plan.ts` (shared planner) | ✅ Imported by both `installer.ts` and `diff.ts`. No surviving duplicate. |
| `lib/policy.ts` (effectivePolicy + effectiveAutoAccept) | ✅ Extracted from sync.ts, with unit tests pinning the precedence matrix. |
| `lib/claudeSettings.ts` (settings types + read/writeSettings) | ✅ install-hook + uninstall-hook deduplicated. |
| `lib/json-stable.ts` (deterministic JSON) | ✅ Used by lockfile.ts and config.ts. |
| `lib/fsutil.ts` (atomic write + pathExists + readFileSafe) | ✅ pathExists deduped 4× → 1; writeFileAtomic adopted; readFileSafe uses `O_NOFOLLOW`. |
| `lib/term.ts` (formatTable, isInteractive, stripColor, formatShortSha) | ✅ Status table renderer + `stripColor` consolidated; SHORT_SHA_LEN named constant. |
| `cli.ts` 1093 → 388 split | ✅ Pure cac wiring + thin glue. New modules: `init.ts`, `install.ts`, `list.ts`, `uninstall.ts`, `shared.ts`. |
| `runSync` 205 → 68 (per-phase helpers) | ✅ Decomposed into `syncOneSource`/`cloneAndParseSource`/`applySource`/`recordSkip`/`logSyncError`. |
| `applyManifest` three-phase split | ✅ `preparePlan` / `stagePlan` / `commitStaged`. |
| `emitHuman` (status.ts) split + injected writer | ✅ `emitSourcesTable` + `emitRecentEvents`; `WriteLine` DI; renderer tests added. |

## Test coverage gaps surfaced by the new review

These are the lib/command modules without companion test files:

- `src/lib/errors.ts` — small, but the constructors now forward `cause` and that contract should be pinned.
- `src/lib/layout.ts` — the cross-platform bug fixed here would have been caught by a 5-line test.
- `src/lib/claudeSettings.ts` — read/writeSettings + isCcppBlock are exercised end-to-end via install-hook.test.ts but lack a focused module test.
- `src/lib/json-stable.ts` — exercised via lockfile + config but no direct unit test.
- `src/lib/iso.ts` (added in this commit) — should ship with a test.
- `src/lib/policy.ts` — has tests (added with the extract).
- `src/lib/plan.ts` — has tests (added with the extract).
- `src/commands/init.ts`, `src/commands/list.ts`, `src/commands/uninstall.ts` — exercised via `tests/cli.test.ts` (subprocess) but no module-local tests.
- `src/commands/config.ts` — exercised via `tests/cli-config.test.ts` (subprocess) but no module-local tests; `applyConfigSet` reads `process.stdin.isTTY` directly which blocks DI-clean unit testing.
- `src/commands/install.ts` — `installSource` (the v0.2.1 collision-retry concern) still has no direct unit tests.

## Modules index

30 modules under `code-review-v0.2.2/`. Each linked to its per-module review.

### Top-level (2)
- [`cli.md`](./cli.md) — argv wiring + glue + classifier (was 1093 LoC, now 388)
- [`index.md`](./index.md) — public type re-export entry

### `src/commands/` (10)
- [`commands-shared.md`](./commands-shared.md) — CommonOpts/ResolvedCommon, commonPaths, log, resolveSourceUrlAndRef
- [`commands-init.md`](./commands-init.md) — runInit
- [`commands-install.md`](./commands-install.md) — runInstall, runInstallInteractive, installSource (largest of the new modules)
- [`commands-list.md`](./commands-list.md) — runList + lockfileRows
- [`commands-uninstall.md`](./commands-uninstall.md) — runUninstall + resolveSourceForUninstall
- [`commands-sync.md`](./commands-sync.md) — runSync (decomposed into per-phase helpers)
- [`commands-status.md`](./commands-status.md) — runStatus, emitSourcesTable, emitRecentEvents
- [`commands-config.md`](./commands-config.md) — runConfig
- [`commands-install-hook.md`](./commands-install-hook.md) — SessionStart hook installer
- [`commands-uninstall-hook.md`](./commands-uninstall-hook.md) — SessionStart hook uninstaller
- [`commands-install-wizard.md`](./commands-install-wizard.md) — first-time setup wizard

### `src/lib/` (15)
- [`lib-config.md`](./lib-config.md) — ccpp.config.json read/write/validate + applyConfigSet
- [`lib-diff.md`](./lib-diff.md) — dry-run changeset (now thin wrapper over plan.ts)
- [`lib-fsutil.md`](./lib-fsutil.md) — readFileSafe (O_NOFOLLOW + maxBytes), writeFileAtomic, pathExists
- [`lib-git.md`](./lib-git.md) — clone/fetch/checkout + isNamedRefRemote
- [`lib-installer.md`](./lib-installer.md) — applyManifest (3-phase staging tree)
- [`lib-lockfile.md`](./lib-lockfile.md) — strict per-entry validation
- [`lib-log.md`](./lib-log.md) — NDJSON sync log
- [`lib-manifest.md`](./lib-manifest.md) — manifest parser + collision detection
- [`lib-term.md`](./lib-term.md) — color, table, prompts, formatShortSha
- [`lib-types.md`](./lib-types.md) — domain types
- [`lib-url.md`](./lib-url.md) — `<url>@<ref>` shorthand parser
- [`lib-plan.md`](./lib-plan.md) — single source of truth for manifest → destPath
- [`lib-policy.md`](./lib-policy.md) — effectivePolicy + effectiveAutoAccept
- [`lib-errors.md`](./lib-errors.md) — UserError/EnvError/CollisionError + EXIT
- [`lib-layout.md`](./lib-layout.md) — CLAUDE_LAYOUT, claudeDirs, classifyDestination
- [`lib-claudeSettings.md`](./lib-claudeSettings.md) — settings.json read/write/isCcppBlock
- [`lib-json-stable.md`](./lib-json-stable.md) — deterministic JSON stringifier

## Recommendation for OSS flip

**Ship.** The remaining items in §"Newly-found issues" are quality-of-life improvements, not correctness blockers — none rise to the bar of "would embarrass a careful first-time user". The cross-platform bug (#1) was the only genuine correctness issue and is fixed in this commit.

If you want a shorter polish-before-public pass, the highest-ROI follow-ups are:
- #4 (uninstall transactionality) — consistent with the staging-tree pattern already used in installer.
- #7 (installSource direct tests) — the collision-retry path is the riskiest untested code today.
- #8 (manifest scanner/detector dedup) — long-standing, low-effort.

Everything else can ride along with future feature work.

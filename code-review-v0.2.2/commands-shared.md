# Module: src/commands/shared.ts

**LoC**: 108  •  **Test file**: no — neither `commands/shared.test.ts` nor any unit test that imports `commonPaths` / `defaultUserCcppHome` / `resolveSourceUrlAndRef` exists. Behaviour is exercised end-to-end via `tests/cli.test.ts`.  •  **v0.2.2 status**: new

## Purpose
Shared types and helpers for the `commands/*` layer. Defines the `CommonOpts` flag bag every subcommand inherits, the `ResolvedCommon` shape returned by `commonPaths`, the config/lockfile path-resolution policy, the `--quiet`-aware `log` helper, and `resolveSourceUrlAndRef` for reconciling `<url>@<ref>` shorthand against an explicit `--ref`.

## Public surface
Types/interfaces:
- `CommonOpts` (line 14) — the raw cac-parsed flag bag.
- `ResolvedCommon` (line 26) — the resolved-paths object handed to every `runX`.

Functions:
- `defaultUserCcppHome()` (line 38) — returns `$CCPP_HOME` or `~/.ccpp`.
- `commonPaths(opts)` (line 56) — resolves config path, lockfile path, claudeHome.
- `log(line, common)` (line 87) — quiet-aware stdout writer.
- `resolveSourceUrlAndRef(rawUrl, flagRef)` (line 97) — splits `<url>@<ref>` and reconciles with `--ref`.

## Strengths
- Genuinely shared — every helper here is used by ≥2 sibling modules. `commonPaths` lives at the boundary between cac-parsed flags and the run-time, exactly where it should.
- Path-precedence is explicit and well-documented (lines 44–55). The four-step ladder (`--config` > `--project` > existing project file > user home) is the kind of contract that must be in one place; this is the right place.
- `defaultUserCcppHome()` (38–42) cleanly extracts the `$CCPP_HOME` override that v0.2.1 mixed inline. Tests pin `CCPP_HOME` to a scratch dir, so this single helper is the load-bearing seam for test isolation.
- `resolveSourceUrlAndRef` (97–108) consolidates a piece of business logic that v0.2.1 duplicated across `doInit` and `doInstall`. Cleanly returns `{ url, ref }` and throws on the conflict case (lines 102–106).
- Type discipline is good: `CommonOpts` carries every shared flag with `?` markers; `ResolvedCommon` strips the optionality once defaults are applied. Downstream consumers can rely on `claudeHome`, `configPath`, `lockfilePath` being populated.

## Concerns

### Cohesion
Strong. Five exports, all serving the "translate raw flags into resolved state" boundary. Nothing here is a leftover or escape hatch.

### Coupling
- Imports `lib/config` (CONFIG_FILENAME), `lib/errors` (UserError), `lib/lockfile` (LOCKFILE_FILENAME), `lib/term` (disableColor), `lib/url` (splitUrlRef). All justified — these are the modules that own the constants and helpers `commonPaths`/`resolveSourceUrlAndRef` need.
- No circular risk: nothing in `lib/*` imports from `commands/*`, and within `commands/*`, `shared.ts` is a leaf (other commands import from it but it imports from none of them).

### Maintainability
- `commonPaths` has one side effect: it calls `disableColor()` when `opts.noColor` is set (line 57). That's a global env-var mutation hidden inside what reads as a pure path-resolution function. A reader scanning for "where does `--no-color` take effect" has to know to look here, not in `cli.ts`. Worth either a doc-comment annotation or extracting the side effect into a separate `applyOutputFlags(opts)` step that the caller invokes explicitly.
- The function is otherwise pure but synchronous-with-fs — `existsSync(projectConfigPath)` (line 67) sets up a TOCTOU window if the project file appears between the check and the eventual read. In practice the gap is measured in microseconds and the worst case is one stale path-resolution; not worth fixing but worth noting.
- `log` (87–89) duplicates a one-line helper that already lives, in slightly different forms, in `commands/install-wizard.ts` (`io.out`) and as raw `process.stdout.write` in `runList` (commands/list.ts:26) and `runUninstall` (commands/uninstall.ts:54). There's no contradiction — they all do "write to stdout, end with newline" — but `log` is the canonical one and the other two should use it.
- `defaultUserCcppHome()` returns the env override unconditionally (line 40). If `CCPP_HOME` is set to a relative path, downstream code resolves it via `join(...)` which keeps it relative. That's surprising — most CLIs absolutise env-derived paths. Probably not worth tightening, but a `resolve(env)` would close the gap.

### Style
- Doc comments are excellent: every public function has a header that spells out precedence rules and edge cases (lines 34–37, 44–55, 91–96).
- Naming is consistent with the rest of the codebase (`opts`, `common`, `claudeHome`).
- `process.cwd()` is called once inside `commonPaths` (line 59) — fine. Tests inject behaviour by `chdir`-ing into a scratch dir.

## Specific issues
- **commands/shared.ts:57** — `commonPaths` mutates global env state via `disableColor()`. Hidden side effect inside a function whose name and signature suggest pure path resolution. Either rename the function or hoist the side effect to the caller.
- **commands/shared.ts:38–42** — `defaultUserCcppHome` doesn't normalise the env-supplied path (no `resolve()`). A relative `$CCPP_HOME` flows through to downstream `join` calls and stays relative.
- **commands/shared.ts:67** — `existsSync` introduces a TOCTOU window between path resolution and read. Theoretical only; flagged for completeness.
- **commands/shared.ts:73–75** — when `--lockfile <path>` is passed, the path is `resolve()`d. When defaulted from configPath, it's `join(dirname(configPath), LOCKFILE_FILENAME)` — also absolute since configPath is already absolute. Fine, just worth confirming both branches return absolute paths (they do).
- No test coverage for `resolveSourceUrlAndRef`. The "ref conflict" branch (lines 102–106) is the kind of validation that benefits from a one-line unit test.

## Suggestions
- **[medium]** Move the `disableColor()` side effect out of `commonPaths` into an explicit `applyOutputFlags(opts)` call in each `do*` handler, or rename `commonPaths` → `resolveCommon` and document the side effect prominently.
- **[medium]** Add a unit test file `commands/shared.test.ts` covering `resolveSourceUrlAndRef` (matching ref OK; mismatched ref throws; URL-only; flag-only) and the four `commonPaths` precedence branches. Both are pure functions and trivially testable.
- **[low]** Have `commands/list.ts` and `commands/uninstall.ts` route their direct `process.stdout.write` calls through `log()` for consistency with the other commands.
- **[low]** Resolve the env-supplied `CCPP_HOME` to an absolute path inside `defaultUserCcppHome` (or document that relative is intentional).

## Resolved from v0.2.1
- N/A (new module). The pieces in here previously lived in `cli.ts`; their consolidation is itself the resolution of the "do too many things" finding against `cli.ts`.

# Module: src/commands/status.ts

**LoC**: 174  •  **Test file**: yes — `/home/mihai/xlnf/ccpp/src/commands/status.test.ts`

## Purpose
Compute and render `ccpp status`: per-source rows from config + lockfile + sync log, plus a tail of recent log events. Supports JSON and human (color, aligned-table) output modes.

## Public surface
- Types: `RunStatusOpts`, `StatusRow`, `StatusReport`
- Functions: `runStatus()`

## Strengths
- Clean two-phase shape: build the immutable `StatusReport` first (lines 88-105), then render (lines 107-112). The data computation is decoupled from presentation cleanly enough that the test file uses `json: true` to skip the renderer.
- Status classification is centralised in `classify()` (lines 54-72) — small, pure function over `(source, lock, log)`. Easy to unit-test in isolation, easy to extend with new statuses.
- `mostRecentFor` (lines 47-52) is a backwards `for` loop — appropriate, given log entries are ordered oldest→newest and we want the last one for a URL. O(n) is fine for the log sizes ccpp will encounter.
- `resolvePolicy` (lines 43-45) makes the per-source ↔ global policy precedence explicit.
- Test coverage hits never-synced, up-to-date, skipped, error, JSON shape, and `recentLimit`. Solid.

## Concerns
### Cohesion
The module mostly "computes the status report", but it also owns the human renderer, the table-width math, and an ANSI-stripper (`stripColor`, lines 171-174). The renderer arguably belongs in `lib/term.ts` or a small `lib/table.ts` — `cli.ts` carries a near-identical aligned-table renderer at `cli.ts:613-624` and a near-identical `stripColor` at `cli.ts:883-886`.

### Coupling
- Imports six modules from `lib/` (config, lockfile, log, term, types). All appropriate; nothing reaches into command-internals.
- Does **not** depend on `cli.ts` — `runStatus` is invoked from `cli.ts:582-589` as a thin wrapper, which is the right inversion of dependencies.

### Maintainability
- `runStatus` is 40 lines (74-113) — readable.
- `emitHuman` is 43 lines (115-157) and mixes two unrelated outputs (the source table and the recent-events list). Could split into `emitSourcesTable` and `emitRecentEvents`. Not urgent.
- The table-width computation (lines 130-138) and `stripColor` (lines 171-174) are duplicated in `cli.ts:613-624` and `cli.ts:883-886` for the `list` command. A `lib/table.ts` would deduplicate both call sites.
- **Local `UserError` (lines 13-15)** is the same duplication pattern flagged in install-hook.ts and uninstall-hook.ts.
- Error-handling around `readConfig`/`readLockfile` uses `.catch((err: Error) => { throw new UserError(err.message); })` (lines 75-77, 83-85) — consistent with `cli.ts:227-229, 593-595, 631-633`. Functionally equivalent to a try/catch but slightly opaque. The `runStatus` path **doesn't** wrap `readSyncLog` errors — line 86 lets a non-ENOENT failure (e.g. permission denied) propagate as a raw Error. Inconsistent.
- Magic number `5` (default `recentLimit`, line 102) — small enough to inline, but a named constant `DEFAULT_RECENT_LIMIT = 5` would help.
- The error-detail truncation `slice(0, 80)` (line 66) and `slice(0, 60)` (line 149) use slightly different lengths — inconsistent, no obvious reason.

### Style
- Line 153 `${`  ${icon} ${e.timestamp}  ${e.trigger}${source}  ${summary}\n`.trimEnd()}\n` is awkward — building a string, trimming end, appending another `\n`. Equivalent to one normal template literal where the trailing `\n` isn't included until the very end. This was probably written to handle the trailing `summary` being optional/empty without a hanging space, but the `.trimEnd()` is also stripping the space after `${trigger}${source}` if `summary === ''`. Consider `[icon, e.timestamp, e.trigger, ...(source ? [source] : []), ...(summary ? [summary] : [])].join(' ')` for clarity.
- `dim('—')` (lines 125-126) is rendered as a literal em-dash — it'll display fine in any modern terminal but could surprise on legacy code pages. Acceptable.
- `Pick<StatusRow, 'status' | 'detail'>` return type on `classify` (line 58) is precise and a nice type-discipline touch.
- `process.stdout.write(`${JSON.stringify(report)}\n`)` (line 108) — note this stringifies the report **with possibly-undefined `detail` keys preserved as missing** because `StatusRow` types `detail` as optional and the build code at line 98 only sets it when defined. Correct, but worth a one-liner comment.

## Specific issues
- `src/commands/status.ts:13-15` — duplicate `UserError` class. Same pattern as install-hook/uninstall-hook/cli/sync. Centralise.
- `src/commands/status.ts:75-77, 83-85` — error wrapping idiom `.catch((err: Error) => { throw new UserError(err.message); })` is used here, but `readSyncLog` at line 86 is **not** wrapped. A read failure on the log will surface as a generic `Error` and trip the `EXIT.ENV` fallback in `cli.ts:889-905`, not the intended `EXIT.USER`. Inconsistent.
- `src/commands/status.ts:130-138` — aligned-table renderer duplicated in `cli.ts:613-624` (the `list` command). Same column-width math, same padding loop.
- `src/commands/status.ts:171-174` — `stripColor` duplicated in `cli.ts:883-886`. Both share the biome ignore comment.
- `src/commands/status.ts:153` — odd `.trimEnd()` + `\n` construction. Suggests the author was working around an edge case but the result is hard to follow.
- `src/commands/status.ts:115-157` — `emitHuman` mixes source-table rendering (lines 116-139) with recent-events rendering (lines 141-156). Two unrelated outputs in one function.
- `src/commands/status.ts:66, 149` — two different slice lengths (80 vs 60) for error-message truncation. Pick one.
- `src/commands/status.ts:102` — `recentLimit` defaults to magic `5`. Promote to a named constant.
- `src/commands/status.ts:115-156` — `emitHuman` writes directly to `process.stdout` rather than taking an injectable `out: (s: string) => void`. Tests rebind `process.stdout.write` to capture (status.test.ts:153-163), which works but is brittle. The wizard module already uses an injected `WizardIO` (cli.ts:400-407) — the same pattern would tidy the status renderer.

## Suggestions
- **[high]** Move the aligned-table renderer + `stripColor` into `src/lib/table.ts` (or extend `lib/term.ts`). Wire up both `status.ts:115-139` and `cli.ts:608-624` to use it. Eliminates roughly 30 lines of duplication and removes the ANSI-strip regex from two files.
- **[high]** Centralise `UserError` in `src/lib/errors.ts` (also affects install-hook, uninstall-hook, sync, cli).
- **[medium]** Wrap the `readSyncLog` call at line 86 with the same `.catch((err: Error) => { throw new UserError(err.message); })` idiom as `readConfig`/`readLockfile`, OR drop the wrapping from those two and let the harness classify uniformly. Pick one policy and apply it everywhere.
- **[medium]** Split `emitHuman` into `emitSourcesTable(report, write)` and `emitRecentEvents(report, write)`. Inject the `write` function so tests don't have to monkey-patch `process.stdout.write`.
- **[low]** Promote `recentLimit` default `5` to `const DEFAULT_RECENT_LIMIT = 5`.
- **[low]** Unify the error-truncation lengths (lines 66 and 149).
- **[low]** Rewrite line 153 as a normal `process.stdout.write([...parts].filter(Boolean).join(' ') + '\n')` to drop the `.trimEnd()` trick.

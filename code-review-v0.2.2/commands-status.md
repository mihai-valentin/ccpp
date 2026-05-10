# Module: src/commands/status.ts

**LoC**: 190  •  **Test file**: yes — `/home/mihai/xlnf/ccpp/src/commands/status.test.ts` (343 LoC)  •  **v0.2.2 status**: refactored

## Purpose
Compute and render `ccpp status`: per-source rows derived from config + lockfile + sync log, plus a tail of recent log events. Supports JSON and human (color, aligned-table) output modes.

## Public surface
- **Types**: `RunStatusOpts`, `StatusRow`, `StatusReport`, `WriteLine`.
- **Functions**: `runStatus()`, `emitHuman()`, `emitSourcesTable()`, `emitRecentEvents()`.

## Strengths
- **All v0.2.1 high-priority issues resolved**: `UserError` now imported from `lib/errors.ts` (line 8); `formatTable` and `stripColor` consolidated into `lib/term.ts` and consumed via `formatTable` import (line 11) — no duplication left versus `cli.ts`.
- **`emitHuman` is genuinely split** (per the v0.2.1 medium suggestion): `emitSourcesTable` (145–162) and `emitRecentEvents` (165–178) are independently callable. `emitHuman` (133–139) is now a 6-line composition, and the `WriteLine` injection (121–125) replaces the `process.stdout.write` monkey-patching the old tests relied on.
- **`WriteLine` DI is clean and minimal** — one type alias (121), one default closure (123–125), three call sites — and matches the `WizardIO` pattern from `commands/install-wizard.ts`. No buffering or fan-out logic; tests just collect lines into an array.
- **`DEFAULT_RECENT_LIMIT = 5` (14)** and **`ERROR_SUMMARY_LEN = 80` (16)** are now named constants — the v0.2.1 magic-number concerns are addressed. `ERROR_SUMMARY_LEN` is also referenced consistently at 67 and 172 — the v0.2.1 inconsistency (80 vs 60) is fixed.
- **Two-phase shape preserved**: build the immutable `StatusReport` first (89–106), then optionally render (108–113). JSON consumers and tests can short-circuit before rendering.
- **`classify` (55–73)** stays a small pure function over `(source, lock, log)` — easy to unit-test, easy to extend. Returns `Pick<StatusRow, 'status' | 'detail'>` (59) — precise type-discipline touch.

## Concerns

### Cohesion
Clean. The module is the report builder + presenter; nothing else leaks. Splitting the emitters cleared the last bit of mixed responsibility flagged in v0.2.1.

### Coupling
- Imports five `lib/*` modules (1–12). Standard.
- `formatTable`, `formatShortSha`, color helpers all from `lib/term.ts` — one shared source. Good.
- No coupling to `cli.ts`. `runStatus` is invoked through cli as a thin wrapper; the dependency arrow is correct.

### Maintainability
- **`runStatus` is 39 lines (75–114)** — readable.
- **`emitSourcesTable` (145–162) is 17 lines, `emitRecentEvents` (165–178) is 13 lines** — both small and single-purpose.
- **`renderStatus` (180–190) is a chained ternary** with four arms. Readable but not great if a 5th status is added later. A `Record<StatusRow['status'], (label: string) => string>` lookup would scale better — minor.
- **`mostRecentFor` (48–53)** uses a backwards `for` loop over the log array. O(n) per source × N sources = O(nN). For small log sizes this is fine; if status logs grow, building a `Map<sourceUrl, lastEntry>` once at the top of `runStatus` would be O(n). Speculative; not urgent.
- **Error-handling consistency**: `readConfig` and `readLockfile` are wrapped (76–78, 84–86) but `readSyncLog` (87) is not. v0.2.1 flagged this exact inconsistency; it is unchanged in v0.2.2. A non-ENOENT failure on the log file (permission denied, FS corruption) propagates as a generic `Error` and trips the env-error fallback rather than `UserError`.
- **Recent events writer (165–178)**: the awkward `${line.trimEnd()}\n` construction (175–176) flagged in v0.2.1 is still present. The `summary` and `source` are conditionally empty, and `trimEnd` exists to strip the trailing space when `summary === ''`. A `[icon, ts, trigger, source, summary].filter(Boolean).join(' ')` form would be clearer.

### Style
- **Naming**: `emitSourcesTable`/`emitRecentEvents`/`emitHuman` are good. `WriteLine` is a sensible alias name.
- **`defaultWrite` (123–125)** as a closure is fine; could be `process.stdout.write.bind(process.stdout)` but the explicit closure is more readable.
- **`renderStatus` as a single expression** (181–189) reads as a decision table — fine inline.
- **`s.lastSync ?? dim('—')`** at 156 — em-dash literal in source. Acceptable; consistent with the v0.2.1 review's tolerant assessment.
- **`if (detail !== undefined) row.detail = detail`** (99) — exactOptionalPropertyTypes pattern. Repeated across cli.ts and other commands; would benefit from the project-wide `withOptional` helper that v0.2.1 also flagged.

## Specific issues
- **commands/status.ts:87**: `readSyncLog` call is not wrapped in `.catch(err => throw new UserError(err.message))` though `readConfig` (76–78) and `readLockfile` (84–86) are. Inconsistent error-mapping policy — flagged in v0.2.1, unchanged.
- **commands/status.ts:175–176**: `${line.trimEnd()}\n` workaround — v0.2.1 noted this; still present. Replace with `[icon, e.timestamp, e.trigger, source, summary].filter(Boolean).join(' ') + '\n'`.
- **commands/status.ts:48–53**: `mostRecentFor` is O(n) per source — fine for current log sizes, but a one-pass `Map` build at the top of `runStatus` would future-proof.
- **commands/status.ts:180–190**: `renderStatus` chained-ternary is a four-armed lookup; a `Record` map would be more extensible.

## Suggestions
- **[medium]** Wrap `readSyncLog` at line 87 with the same `.catch(err => throw new UserError(err.message))` idiom as the surrounding `readConfig`/`readLockfile` calls — close the v0.2.1 inconsistency.
- **[low]** Rewrite the line-175 `trimEnd()` construction as `filter(Boolean).join(' ')` form.
- **[low]** If logs grow beyond a few hundred entries, build a `Map<sourceUrl, lastEntry>` once at the top of `runStatus` instead of calling `mostRecentFor` per source.
- **[low]** Consider a `Record<StatusRow['status'], (s: StatusRow) => string>` lookup for `renderStatus` — only valuable if a 5th status arrives.

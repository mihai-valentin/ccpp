# Module: src/commands/config.ts

**LoC**: 145  •  **Test file**: no module-local unit test; integration coverage at `tests/cli-config.test.ts` (191 LoC, subprocess-based) and `lib/config.test.ts` for the underlying lib.  •  **v0.2.2 status**: small changes (formatValue accepts `dim?: boolean`, lib `parseKeyOrThrow` underneath)

## Purpose
Implements `ccpp config <action> [key] [value]` — a thin presentation/IO shell over `lib/config.ts` for the four actions `get`, `set`, `reset`, `list`. Owns the action-dispatch switch, the autoAccept/ack handshake for `set`, and JSON-vs-text emission for each verb.

## Public surface
- **Types**: `ConfigAction` (`'get' | 'set' | 'reset' | 'list'`), `RunConfigOpts`.
- **Functions**: `runConfig(opts: RunConfigOpts): Promise<void>`.
- **Re-exports**: `CONFIG_FILENAME` (line 145).

## Strengths
- **The `formatValue` consolidation** (136–142) closes the v0.2.1 low-priority finding about two ways of rendering `(unset)`: the helper now takes an optional `{ dim?: boolean }` and the call sites (103, 105, 118, 138) all go through it.
- **`parseKeyOrThrow`** is now used internally in `lib/config.ts` (referenced at config.ts:208, 245, 273, 396) — error messages are uniform across `get`/`set`/`reset`. The wrapper keeps the command-layer dispatch clean.
- **Dispatcher (37–70) is tight**: a clean `switch` on `action`, each arm a one- or two-line guard plus a `return emit*(...)` call. Easy to scan.
- **Clean error boundary**: `runConfig` throws plain `Error`s (per the doc comment 30–33); cli.ts wraps them into `UserError` at the boundary. Still the cleanest error boundary in the repo.
- **JSON output wired per-verb** (84, 99, 112, 123) — every action has both a JSON and a human path.
- **`loadOrEmptyConfig` (73–77)** preserves the "fresh user can `config list` before init" UX.
- **No coupling to `cli.ts`** — module is a leaf below cli.

## Concerns

### Cohesion
Tight. This file is exclusively the CLI presentation layer for `lib/config.ts`. Nothing leaks.

### Coupling
- Imports an eleven-symbol surface from `lib/config.ts` (1–14). Wide but justified — this is the command-layer adapter for that module.
- Imports `dim`, `green`, `promptYesNo` from `lib/term.ts` (15). Standard.
- No coupling to `cli.ts` (errors flow up, not down).

### Maintainability
- **`runConfig` is 38 lines (34–71)** — easy to read.
- **`emit*` helpers are short** (8–15 lines each).
- **Argument validation runs after a filesystem read**: `if (!opts.key)` checks at lines 41 and 45 fire after `loadOrEmptyConfig` (35) has touched disk. Same v0.2.1 finding; unchanged. A pre-flight validator at the top would fail faster.
- **Direct `process.stdin.isTTY` probe at line 50** — same v0.2.1 finding. `runSync` injects `isTTY` for testability (sync.ts:55); `runConfig` does not, which is why there is no module-local unit test today. The `tests/cli-config.test.ts` integration test exercises the path through subprocess, but that is slow and harder to maintain than an injected DI.
- **`setOpts` mutation pattern** (55–60) — same project-wide optional-field-by-mutation idiom as v0.2.1. Acceptable but not yet centralised.
- **The "v0.1.1 policy fields" message (132)** is *unchanged* from v0.2.1 — still references a release version that has rotted. By v0.2.2 the message is misleading; "policy defaults" or "policy fields" is the better wording.
- **`emitList` recomputes `keyWidth` every call** (88) via `Math.max(...rows.map(...))`. For O(few) rows it's fine; same v0.2.1 micro-finding.
- **Unused re-export of `CONFIG_FILENAME`** (145) — same v0.2.1 finding. cli.ts imports `CONFIG_FILENAME` directly from `lib/config.js`, not from this module. Dead export.

### Style
- **Naming**: `emitList`/`emitGet`/`emitSet`/`emitReset` consistent and clear.
- **`return emitX(...)` at lines 39, 42, 63, 68** — the form expresses "terminal action" since `emit*` returns void. Reads fine.
- **`formatValue(value, opts: { dim?: boolean } = {})`** signature (136) is clean. Used once with `{ dim: true }` (103) and four times without (105, 118, 91, 138). Symmetric.
- **No `any`, no casts**: `getConfigValue` returns `unknown`; `formatValue` accepts `unknown`. Good type discipline.

## Specific issues
- **commands/config.ts:50**: direct `process.stdin.isTTY` probe; not injectable. Adding `isTTY?: boolean` to `RunConfigOpts` (mirror of `RunSyncOpts:55`) would unlock module-local unit tests and close the test gap.
- **commands/config.ts:41, 45–47**: missing-arg checks after a filesystem read. Move to a pre-flight validator at the top of `runConfig`.
- **commands/config.ts:132**: hard-coded `"v0.1.1 policy fields"` message. Drop the version reference. Same v0.2.1 finding, unfixed.
- **commands/config.ts:145**: `export { CONFIG_FILENAME }` is unused — dead export. Same v0.2.1 finding, unfixed. cli.ts imports `CONFIG_FILENAME` directly from `lib/config.js`.
- **commands/config.ts:55–60**: optional-field-by-mutation pattern. Project-wide.
- **commands/config.ts:88**: `keyWidth` computed via spread on every list call. Micro; not blocking.
- **commands/config.ts:34–71**: still no module-local test file. Integration coverage at `tests/cli-config.test.ts` works but is subprocess-based — slow and brittle.

## Suggestions
- **[medium]** Add a `commands/config.test.ts` that drives the four actions in-process. Inject `isTTY` (via `RunConfigOpts.isTTY?: boolean`) and replace the line-50 `process.stdin.isTTY` read. Eliminates the only gap in the command-layer test coverage and unblocks fast unit tests for the ack-gate.
- **[low]** Drop `export { CONFIG_FILENAME }` at line 145 — verify no caller imports it from this module first.
- **[low]** Reword the line-132 message to remove the `v0.1.1` reference (e.g., `'reset all policy fields to defaults'`).
- **[low]** Move missing-arg validation to a pre-flight check at the top of `runConfig`, before `loadOrEmptyConfig`.

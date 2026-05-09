# Module: src/commands/config.ts

**LoC**: 143  •  **Test file**: no module-local test. Configuration logic is exercised at the `lib/config.ts` layer (`lib/config.test.ts`); this command shim has no direct test.

## Purpose
Implements `ccpp config <action> [key] [value]` — a thin presentation/IO shell over `lib/config.ts` for the four actions `get`, `set`, `reset`, `list`. Owns the action-dispatch switch, the autoAccept/ack handshake for `set`, and JSON-vs-text emission for each verb.

## Public surface
- **Types**:
  - `ConfigAction` — `'get' | 'set' | 'reset' | 'list'`.
  - `RunConfigOpts` — the shape consumed by `runConfig`.
- **Functions**:
  - `runConfig(opts: RunConfigOpts): Promise<void>` — entry point, dispatches to the four `emit*` helpers.
- **Re-exports**:
  - `CONFIG_FILENAME` (line 143) — re-exported for CLI convenience.

## Strengths
- The dispatcher (lines 37–70) is a clean `switch` on `action`. Each arm is a one- or two-line guard followed by a delegated `emit*` call. Easy to scan.
- The autoAccept/ack handshake at 49–60 is the right shape: ask `lib/config.ts` whether confirmation is needed (`requiresAcknowledgement`), error-fail-fast on non-TTY when no `--auto-accept`, otherwise wire a `confirm` callback into `applyConfigSet`. Single source of truth (the `lib` module) for the ack rule.
- JSON output is wired per-verb (lines 81, 98, 111, 122) — every action has both a JSON and a human path, no holes.
- `loadOrEmptyConfig` (73–77) handles the "no config yet, but `config get foo` should return `(unset)` not error" case correctly. That is a small but real UX win: a fresh user can run `ccpp config list` before `ccpp init` and see defaults.
- `formatValue` (136–140) handles `undefined | null | string | other` as a single dispatch. Compact and correct.

## Concerns

### Cohesion
Tight. This file is exclusively about presenting `lib/config.ts` to the CLI. Nothing leaks.

### Coupling
- Imports a wide surface from `lib/config.ts` (lines 1–14) — eleven symbols. That is a lot, but justified: this file is the command-layer adapter for that module.
- Imports `dim`, `green`, `promptYesNo` from `lib/term.ts` (line 15). Standard.
- No coupling to `cli.ts` — `runConfig` errors are plain `Error`s (per the doc at 30–33), and `cli.ts:doConfig` wraps them into `UserError` at the boundary (cli.ts:684–697). This is the cleanest error boundary in the repo and a model the other command modules (sync.ts, install-hook.ts, status.ts) should follow.

### Maintainability
- `runConfig` is 38 lines (34–71) and easy to read.
- The four `emit*` helpers are short (8–15 lines each).
- The early-bail `if (!opts.key) throw new Error(...)` at lines 41 and 45 are subtle — they happen *after* `loadOrEmptyConfig` has already done a filesystem read. A pre-validation block at the top of `runConfig` (`if (action === 'get' && !key) throw ...; if (action === 'set' && (!key || value === undefined)) throw ...;`) would fail faster and be easier to test.
- The `ackKind !== null && opts.autoAccept !== true && !process.stdin.isTTY` check at line 50 is correct but couples this command to `process.stdin.isTTY` directly. Other modules (sync.ts at line 158) take the TTY as an injectable opt for testability. `runConfig` cannot be unit-tested at the ack-gate today without monkey-patching `process.stdin.isTTY`, which is why there is no test.
- `setOpts` is built by mutating an empty object (lines 55–60) — same pattern as the four other places in cli.ts where optional fields are conditionally assigned. Standardize.
- `formatValue` returns `'(unset)'` for `null | undefined` (line 137) and elsewhere `dim('(unset)')` is written manually for the same case (line 103). Two slightly different strings (one colored, one not). Pick one and have `formatValue` do the dim/no-dim decision based on a flag.
- `emitReset` has a hard-coded "v0.1.1 policy fields" string at line 132. That is a release-version reference that will rot — by v0.1.6 the message is misleading. Either drop the version or compute it from `package.json` (and even then, the message still claims a specific version owns the field set).
- `process.stdout.write(...)` is called directly throughout (lines 84, 92, 99, 103, 106, 113, 118, 123, 130, 132). Unlike `cli.ts`, there is no `log()` wrapper that respects `quiet`. Most paths *do* respect quiet via early returns at lines 87, 117, 128, but the JSON paths bypass that — fine, JSON is JSON. Just inconsistent in form: some helpers check quiet, others rely on the JSON branch having returned.

### Style
- Naming: `emitList`, `emitGet`, `emitSet`, `emitReset` is consistent and good.
- The mutually recursive-looking `runConfig` → `emit*` flow is actually one-way (no `emit*` calls back into `runConfig`); the `return emitX(...)` form at lines 39, 42, 63, 68 is purely to express "this is the terminal action for this case", since `emit*` returns void. It reads fine, but `emitX(...); return;` would be a hair clearer.
- Type discipline: `getConfigValue` returns `unknown`; `formatValue` accepts `unknown` (line 136). No casts. Good.
- The trailing `export { CONFIG_FILENAME };` (line 143) with comment "Expose the filename constant for CLI use alongside the default config path" is fine but `cli.ts` already imports `CONFIG_FILENAME` directly from `lib/config.js` (cli.ts:24). The re-export here is dead — nothing imports it from `commands/config.ts`. Verify and drop.

## Specific issues
- **commands/config.ts:50**: `!process.stdin.isTTY` directly probes the runtime. Inject as `isTTY?: boolean` like `runSync` does (sync.ts:65–69) so this branch can be tested.
- **commands/config.ts:41, 45–47**: missing-arg validation runs after a file read. Move to a pre-flight validator.
- **commands/config.ts:103, 137**: two ways to render `(unset)` — `dim('(unset)')` at the call site vs. plain `(unset)` inside `formatValue`. Inconsistent.
- **commands/config.ts:132**: hard-coded `"v0.1.1 policy fields"` will become misleading. Drop the version or reword to "policy defaults".
- **commands/config.ts:143**: `export { CONFIG_FILENAME };` is unused — `cli.ts` imports `CONFIG_FILENAME` directly from `lib/config.js`. Dead export.
- **commands/config.ts:55–60**: optional-field-by-mutation pattern — same shape as cli.ts:344–351, 376–388, etc. Worth a shared idiom.
- **commands/config.ts:80–93**: `emitList` recomputes `keyWidth` every call from `Math.max(...rows.map(r => r.key.length), 0)`. Micro, but if `listConfig` ever returns hundreds of rows the spread becomes O(n) twice. Loop once.
- **commands/config.ts:34–71**: no test file. Adding `runConfig.test.ts` with a fake `RunConfigOpts` shape (parallel to `WizardIO`) and an in-memory config path would unlock unit tests for the dispatch + ack-gate logic.

## Suggestions
- **[high]** Add `commands/config.test.ts`. Drive the four actions in-process against a tmpdir config path. Assert the ack-gate behavior (currently untested) and the JSON output shapes. Inject `isTTY` and `confirm` (rename from internal `setOpts.confirm`) the way `runSync` does.
- **[medium]** Refactor `runConfig` to do all argument validation up front, before `loadOrEmptyConfig`. Move the `if (!opts.key)` checks to the top.
- **[medium]** Inject TTY detection (`isTTY?: boolean`) into `RunConfigOpts` and replace the direct `process.stdin.isTTY` read at line 50.
- **[low]** Drop `export { CONFIG_FILENAME }` (line 143) — it is unused.
- **[low]** Reword the line-132 message to drop the `v0.1.1` reference.
- **[low]** Consolidate `(unset)` rendering: have `formatValue` accept an optional `dim?: boolean` and use it consistently.
- **[low]** Replace the `setOpts` mutation pattern (55–60) with a single-expression object literal once a shared `withOptional` helper exists.

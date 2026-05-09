# Module: src/commands/uninstall-hook.ts

**LoC**: 101  •  **Test file**: yes — `/home/mihai/xlnf/ccpp/src/commands/uninstall-hook.test.ts`

## Purpose
Remove the ccpp SessionStart entry from `settings.json` (user or project scope). Reuses `isCcppBlock` and `settingsPathFor` from `install-hook.ts`; cleans up empty `hooks.SessionStart` and empty `hooks` objects to leave the settings file as it was before install.

## Public surface
- Types: `RunUninstallHookOpts`, `UninstallHookResult`
- Functions: `runUninstallHook()`
- Internal types (duplicated from install-hook.ts): `HookCommand`, `SessionStartBlock`, `ClaudeSettings`

## Strengths
- Reuses `isCcppBlock` and `settingsPathFor` from `install-hook.ts` (line 4) — exactly the right shared surface.
- Three distinct no-op paths (no settings file, no SessionStart array, no ccpp block) all collapse to the same `noop: true` result (lines 78-90), making the caller's job trivial.
- Cleans up empty containers symmetrically: empty `SessionStart` array → delete the key; empty `hooks` object → delete that too (lines 93-95). Restores the file to its pre-install state.
- The `emit` closure (lines 61-76) localises output formatting; each return path goes through it.
- Test for `--chain` round-trip (uninstall-hook.test.ts:56-76) confirms the asymmetric case: ccpp added, foreign hook stays.

## Concerns
### Cohesion
Single responsibility, executed cleanly. Like `install-hook.ts` it mixes data mutation with formatted output (lines 62-74), but the boundary is at least confined to the `emit` closure.

### Coupling
- Depends only on `node:fs`, `node:path`, `../lib/term.js`, and three named imports from `./install-hook.js` (line 1-4). One-way coupling to install-hook is intentional and correct.

### Maintainability
- 101 LoC, one main function, no nesting deeper than 2 levels. Easy to maintain.
- **Three duplicated interface declarations** (`HookCommand`, `SessionStartBlock`, `ClaudeSettings`, lines 21-37) are byte-for-byte copies of install-hook.ts:35-51. Same drift risk.
- **`readSettings` and `writeSettings` are duplicates** of install-hook.ts:98-111, with one tiny difference: this version returns `null` on ENOENT (line 43) instead of `{}`. The semantic split is fine — uninstalling a non-existent file is a no-op, not a creation — but the rest is identical and should be extracted.
- Same non-atomic write problem as `install-hook.ts` (line 50).
- The conditional-spread idiom for forwarding optional opts (`...(opts.claudeHome !== undefined && { claudeHome: opts.claudeHome })`, lines 56-57) is a TypeScript-strict workaround for `exactOptionalPropertyTypes`. Verbose but correct. Pattern repeats in `cli.ts` — fine to keep, but a `pickDefined` helper would tighten it.

### Style
- No local `UserError` class — this module simply doesn't throw user errors (file-missing is a no-op, write-failure bubbles up as a wrapped Error). Consistent with the actual semantics; nothing is bypassing the error taxonomy.
- `if (filtered.length === blocks.length)` (line 88) — clean way to detect "ccpp wasn't there". Comment would help readers parse why this is the no-op condition.
- `settings.hooks!` non-null assertion (line 92) is defensible: the previous `Array.isArray(blocks)` guard at line 83 implies `settings.hooks` is set. But the `!` is a code-smell; a destructured `const { hooks } = settings` after the guard reads cleaner.

## Specific issues
- `src/commands/uninstall-hook.ts:21-37` — `HookCommand`, `SessionStartBlock`, `ClaudeSettings` interfaces duplicated verbatim from install-hook.ts:35-51.
- `src/commands/uninstall-hook.ts:39-51` — `readSettings` and `writeSettings` are near-duplicates of install-hook.ts:98-111. The only meaningful diff is `null` vs `{}` on ENOENT.
- `src/commands/uninstall-hook.ts:50` — same non-atomic write problem as install-hook (no temp+rename); a crash mid-write corrupts `settings.json`.
- `src/commands/uninstall-hook.ts:54-58` — conditional-spread for `claudeHome` and `cwd` is correct under `exactOptionalPropertyTypes` but visually noisy. A small `pickDefined({claudeHome, cwd})` helper would tidy this and the similar idioms in `cli.ts:213-214, 351, 470`.
- `src/commands/uninstall-hook.ts:92` — non-null assertion `settings.hooks!` is technically safe given the line-83 guard, but reads as a hole in the type narrowing. Restructure the guard to extract `hooks` once.
- `src/commands/uninstall-hook.ts:41` — `JSON.parse(...) as ClaudeSettings` with no shape validation. Malformed `settings.json` throws "Failed to read" with the parser message — adequate but the same as install-hook (no specific suggestion to the user). Worth a one-liner like "If you've hand-edited the file, validate it with `jq`."
- The module never validates the `scope` value against the `HookScope` union beyond TypeScript narrowing — an internal caller that passes a bogus scope at runtime would silently fall through to the user-scope branch in `settingsPathFor`. Not exploitable from the CLI (cac filters `--project`), but worth a runtime guard if this ever gets exposed via a JSON input.

## Suggestions
- **[high]** Extract a shared `src/lib/claudeSettings.ts` with: `ClaudeSettings`, `SessionStartBlock`, `HookCommand`, `readSettings(path) -> Promise<ClaudeSettings | null>`, `writeSettings(path, settings) -> Promise<void>` (atomic). Both hook commands collapse to ~40 LoC each.
- **[high]** Make `writeSettings` atomic (temp + rename). Same fix as install-hook.
- **[medium]** Add a `pickDefined` helper for the optional-spread idiom on lines 54-58. Reuse across `cli.ts` install paths (cli.ts:213-214, 351, 470).
- **[medium]** Refactor the lines 82-92 block to extract `hooks` and the filtered list once, eliminating the `settings.hooks!` non-null assertion at line 92.
- **[low]** When `scope`/`claudeHome`/`cwd` mismatches conceptually (e.g. `scope: 'project'` with `claudeHome` set, or vice versa), document the precedence in the doc comment of `RunUninstallHookOpts`.

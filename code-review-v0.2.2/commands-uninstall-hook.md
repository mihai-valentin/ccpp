# Module: src/commands/uninstall-hook.ts

**LoC**: 68  •  **Test file**: yes — `/home/mihai/xlnf/ccpp/src/commands/uninstall-hook.test.ts` (114 LoC)  •  **v0.2.2 status**: refactored

## Purpose
Remove the ccpp SessionStart entry from `settings.json` (user or project scope). Reuses `isCcppBlock` and `settingsPathFor` from `install-hook.ts` and the shared settings IO from `lib/claudeSettings.ts`. Cleans up empty `hooks.SessionStart` arrays and empty `hooks` objects so the file is restored to its pre-install state.

## Public surface
- **Types**: `RunUninstallHookOpts`, `UninstallHookResult`.
- **Functions**: `runUninstallHook()`.

## Strengths
- **All v0.2.1 high-priority issues resolved**:
  - The duplicated `HookCommand` / `SessionStartBlock` / `ClaudeSettings` interfaces are gone — imported from `lib/claudeSettings.ts` (line 1).
  - `readSettings` / `writeSettings` are no longer copy-pasted; both modules share one implementation.
  - Atomic settings write inherited via `writeFileAtomic` inside `lib/claudeSettings.ts`.
- **Module is now 68 LoC**, down from 101 (a 33% reduction), purely from extracting the shared shape — single-responsibility is sharper.
- **Three no-op paths still collapse cleanly to one return shape** (45–57): no settings file (45), no `SessionStart` array (50–52), no ccpp block (54–57). The caller sees `noop: true` either way.
- **Symmetric cleanup of empty containers**: empty `SessionStart` array → delete the key (61); empty `hooks` object → delete `hooks` (62). Pre-install state is preserved.
- **The `emit` closure (28–43)** localises output formatting; every return path goes through it, so JSON/quiet/human modes stay in sync.

## Concerns

### Cohesion
Single-purpose, executed cleanly. Like `install-hook.ts` it mixes data mutation with output (28–43), but at 68 LoC the boundary is trivially auditable.

### Coupling
- Imports only `lib/claudeSettings.js`, `lib/term.js`, and three named imports from `./install-hook.js` (1–3). One-way dependency on `install-hook.ts` for `HookScope` + `settingsPathFor` — correct shape.
- No `node:fs` / `node:path` imports anymore — those moved out with the settings IO. Cleaner.

### Maintainability
- **One main function, no nesting deeper than 2 levels.** Easy to maintain.
- **The conditional-spread idiom for forwarding optional opts** (22–24) is the same TypeScript-strict workaround flagged in v0.2.1 — a project-wide `pickDefined` helper would tidy it. Same pattern repeats in cli.ts.
- **`settings.hooks!` non-null assertion (59)** is still present. v0.2.1 flagged this; the line-50 `Array.isArray(blocks)` guard does imply `settings.hooks` is set, but the `!` reads as a hole in narrowing. A destructure after the guard (`const hooks = settings.hooks!; …` or restructuring to `if (!settings.hooks?.SessionStart) return …`) would be cleaner. Minor.
- **`isCcppBlock` is imported from `claudeSettings.ts` (line 1)** — but `commands/install-hook.ts:17` re-exports the same symbol "for backward compatibility". This module *could* import from either; importing from `claudeSettings.ts` directly is the right call. The dual export path is a minor smell that the install-hook re-export should probably be dropped.
- **No defensive validation of `scope`** at runtime — flagged in v0.2.1. Trusts the type system. Not exploitable today (CAC filters bad flags), but worth a runtime guard if the API ever takes JSON input.

### Style
- **Naming**: `runUninstallHook` mirrors `runInstallHook` — symmetric. `noop` field on the result is well-typed.
- **`if (filtered.length === blocks.length)` (55)** — the "ccpp wasn't there" detection. v0.2.1 suggested a comment; still none. A one-liner like `// ccpp block wasn't in the array — nothing to remove.` would help.
- **No local `UserError`** — this module doesn't throw for user errors (file-missing is a no-op). Consistent with the actual semantics.

## Specific issues
- **commands/uninstall-hook.ts:59**: `settings.hooks!` non-null assertion — same v0.2.1 finding. Restructure the line-50 guard to extract `hooks` once.
- **commands/uninstall-hook.ts:22–24**: conditional-spread for `claudeHome`/`cwd` — visually noisy. Same pattern in cli.ts; project-wide `pickDefined` would clean up.
- **commands/uninstall-hook.ts:55**: undocumented "no ccpp block" detection. Add a one-line comment.
- **commands/uninstall-hook.ts:1**: imports `isCcppBlock` from `lib/claudeSettings.js` while `install-hook.ts:17` still re-exports the same symbol — once that re-export is dropped, this module's import path is the only one.

## Suggestions
- **[low]** Restructure the line-50 guard to eliminate `settings.hooks!` (59):
  ```ts
  const hooks = settings.hooks;
  const blocks = hooks?.SessionStart;
  if (!Array.isArray(blocks) || blocks.length === 0) return emit(...);
  // …filter…
  if (filtered.length === 0) {
    delete hooks!.SessionStart;
    if (Object.keys(hooks!).length === 0) delete settings.hooks;
  }
  ```
- **[low]** Add a comment at 55 explaining the "filtered.length === blocks.length" no-op detection.
- **[low]** Coordinate with `install-hook.ts` to drop the back-compat re-export of `isCcppBlock` (install-hook.ts:17), once auditing confirms no caller imports it from there.

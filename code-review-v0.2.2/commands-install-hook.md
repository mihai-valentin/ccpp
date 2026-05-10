# Module: src/commands/install-hook.ts

**LoC**: 165  •  **Test file**: yes — `/home/mihai/xlnf/ccpp/src/commands/install-hook.test.ts` (202 LoC)  •  **v0.2.2 status**: refactored

## Purpose
Materialise `<ccppHome>/hook.sh` (atomically) and register a Claude Code SessionStart hook entry inside `settings.json` (user or project scope). Owns the canonical `HOOK_SCRIPT_BODY`, the action-classification (`created`/`updated`/`chained`/`replaced`), and the small layer of helpers (`defaultCcppHome`, `defaultClaudeHome`, `settingsPathFor`) reused by `uninstall-hook.ts`.

## Public surface
- **Types**: `HookScope`, `RunInstallHookOpts`, `InstallHookResult`.
- **Constants**: `HOOK_SCRIPT_BODY`.
- **Functions**: `defaultCcppHome()`, `defaultClaudeHome()`, `settingsPathFor()`, `runInstallHook()`.
- **Re-exports**: `isCcppBlock` (line 17, kept for back-compat with any caller still importing from this file).

## Strengths
- **All three v0.2.1 high-priority issues resolved**:
  - Local `UserError` removed; imported from `lib/errors.ts` (line 11).
  - Settings shape types (`HookCommand`, `SessionStartBlock`, `ClaudeSettings`) and the `read/writeSettings` pair extracted into `lib/claudeSettings.ts` (lines 4–10) — no duplication against `uninstall-hook.ts`.
  - `writeSettings` now atomic via `writeFileAtomic` (`lib/claudeSettings.ts:42–44`) — the corruption risk on a SIGINT mid-write is closed.
- **`ACTION_VERB` lookup (44–49)** replaces the v0.2.1 verb-rendering ternary chain — flat, exhaustive, easy to extend if a new action arrives.
- **Hook-script materialisation also atomic**: `writeHookScript` (92–98) writes via `writeFileAtomic` then `chmod` — same crash-safety as the settings write.
- **Action-classification cascade in `runInstallHook` (135–151)** is a flat `if/else if/else` ladder — easy to read, terminates in `UserError` for the genuinely-ambiguous case (148–150).
- **`isCcppBlock` and `settingsPathFor`** are correctly exposed for `uninstall-hook.ts` to import — exactly the symmetric install/uninstall boundary.
- **Test coverage** still hits all four `action` outcomes plus `--chain`/`--force` mutual exclusion plus project scope and unrelated-keys preservation. The hook-body parity test (mentioned in v0.2.1 as a gap) exists at `src/commands/install-hook.test.ts` per the recent commit log entry `test(hooks): pin HOOK_SCRIPT_BODY to scripts/hook.sh`.

## Concerns

### Cohesion
Tightly focused. `runInstallHook` (117–165) still mixes data mutation with output formatting (156–162), but the boundary is at a natural endpoint after the action is determined. Same convention as `uninstall-hook.ts` — project-wide pattern, harmless at this size.

### Coupling
- Imports `node:fs/os/path`, `lib/claudeSettings`, `lib/errors`, `lib/fsutil`, `lib/term` (1–13). Clean and minimal.
- The back-compat `export { isCcppBlock }` (17) is documented but worth auditing — once the codebase no longer imports it from this file, the re-export is dead and should be removed.
- One-way coupling to `lib/claudeSettings.ts` for the settings-shape types and IO. Healthy.

### Maintainability
- **`runInstallHook` is 49 lines (117–165)** — readable, mostly a flat decision table.
- **`makeCcppBlock` (106–115)** documents the matcher (`startup|resume|clear`) inline (107–110) — closes the v0.2.1 low-priority "magic string undocumented" finding.
- **`shellQuote` (101–104)** is the same allow-list-then-quote pattern flagged in v0.2.1; still POSIX-safe for the common case. Not an issue in practice.
- **`HOOK_SCRIPT_BODY` (56–71)** is a multi-line template literal with backslash-escaped `$` for shell variables — readable. The "Kept in sync with `scripts/hook.sh`" comment (58) now has a parity test (per the commit log) — drift risk closed.
- **`opts.chain === true` / `opts.force === true`** ceremony (118, 141, 144) — same as v0.2.1; minor verbosity. Treating optional booleans as plain `boolean` (default `false`) would clean these up project-wide.
- **`existingCcppIdx >= 0` overwrite without comparing scriptPath**: when a ccpp block already exists, line 136 unconditionally replaces it with the freshly-computed block (`action='updated'`), even if the new `scriptPath` differs from the old one. v0.2.1 flagged this as undocumented intent; still no comment. Add `// Re-points to current scriptPath — handles CCPP_HOME changes between installs.`
- **`process.env.CCPP_HOME`** is read directly in `defaultCcppHome` (74–77). Tests that don't pass `opts.ccppHome` and don't scrub the env will pick up an inherited value — same v0.2.1 hygiene concern, unchanged. Not a bug, but a project-wide `delete process.env.CCPP_HOME` in `beforeEach` would harden.

### Style
- **Naming**: `defaultCcppHome` / `defaultClaudeHome` / `settingsPathFor` / `makeCcppBlock` / `writeHookScript` are all clear.
- **JSDoc on `HOOK_SCRIPT_BODY` (52–55)** explains where the file lands and the scripts/hook.sh parity expectation.
- **`InstallHookResult['action']` typed as a string union** is referenced in the `ACTION_VERB` map type (44) — TypeScript catches drift if a new action is added but not mapped. Good.
- **The `// Re-exports kept for backward compatibility` comment** (15–16) is honest about the reason. Worth verifying no external callers rely on it; if all internal callers import from `lib/claudeSettings.ts`, drop the re-export.

## Specific issues
- **commands/install-hook.ts:17**: `export { isCcppBlock }` — back-compat re-export. Audit current callers; if none, remove.
- **commands/install-hook.ts:135–137**: existing-ccpp-block overwrite path is undocumented. Add a one-line comment explaining the `scriptPath` re-point rationale (CCPP_HOME changes between installs).
- **commands/install-hook.ts:74–77**: `defaultCcppHome` reads `process.env.CCPP_HOME` directly; same env-leak hygiene concern as v0.2.1. Consider scrubbing in test setup or routing through a `getEnv(name)` helper that tests can stub.
- **commands/install-hook.ts:118, 141, 144**: `=== true` boolean ceremony for optional `chain`/`force` flags. Consistent project-wide; consider a project-wide cleanup pass.
- **commands/install-hook.ts:101–104**: `shellQuote` allow-list omits `,` and `=` — common case still safe. Document the allow-list intent or expand it slightly to handle `--ccpp-home /tmp/dir,with,commas` edge cases.

## Suggestions
- **[medium]** Audit and remove the `export { isCcppBlock }` re-export at line 17 once no callers depend on it.
- **[low]** Add a one-line comment at 135–137 explaining the existing-block overwrite rationale.
- **[low]** Centralise env-var reads (or scrub `CCPP_HOME` in test setup) — same hygiene fix flagged in v0.2.1.
- **[low]** Project-wide: drop `=== true` for optional boolean flags; either default them in the type or treat them as plain booleans.

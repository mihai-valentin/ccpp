# Module: src/commands/install-hook.ts

**LoC**: 189  •  **Test file**: yes — `/home/mihai/xlnf/ccpp/src/commands/install-hook.test.ts`

## Purpose
Materialise `~/.ccpp/hook.sh` and register a Claude Code SessionStart hook entry inside `settings.json` (user or project scope). Owns the canonical `HOOK_SCRIPT_BODY`, the `isCcppBlock` detector, and `settingsPathFor` — all of which are reused by `uninstall-hook.ts`.

## Public surface
- Types: `HookScope`, `RunInstallHookOpts`, `InstallHookResult`
- Constants: `HOOK_SCRIPT_BODY`
- Functions: `defaultCcppHome()`, `defaultClaudeHome()`, `settingsPathFor()`, `isCcppBlock()`, `runInstallHook()`
- Internal types (not exported but worth noting for the duplication finding): `HookCommand`, `SessionStartBlock`, `ClaudeSettings`

## Strengths
- Owning `HOOK_SCRIPT_BODY` here as a single source of truth (kept in sync with `scripts/hook.sh`) means the wire-level body is testable and version-controlled (lines 58-73).
- `isCcppBlock` (line 94-96) and `settingsPathFor` (line 85-92) are correctly factored out and re-imported by `uninstall-hook.ts` — exactly the boundary you'd want for symmetric install/uninstall.
- The action-classification cascade in `runInstallHook` (lines 148-167) is a flat, exhaustive `if/else if/else` ladder — easy to read, terminates in a `UserError` for the genuinely-ambiguous case.
- `shellQuote` (line 121-124) is a sensible POSIX-safe escape for the script path embedded in the hook command.
- Test coverage hits all four `action` outcomes plus `--chain`/`--force` mutual exclusion plus project scope and unrelated-keys preservation.

## Concerns
### Cohesion
The module is tightly focused on "register the SessionStart hook" — that's one thing. The minor smell is that it also formats human/JSON output in the same function (`runInstallHook`, lines 172-186), mixing the data-mutation step with presentation. Same pattern as `uninstall-hook.ts`, so it's a project-wide convention rather than a one-off — but in a module this small it is harmless.

### Coupling
- Imports only `node:fs`, `node:os`, `node:path`, and `../lib/term.js` (line 1-4). Clean.
- `uninstall-hook.ts` imports `HookScope`, `isCcppBlock`, `settingsPathFor` from this file (uninstall-hook.ts:4) — a healthy one-way dependency, not circular.
- `cli.ts` imports `HookScope`, `InstallHookResult`, `runInstallHook` (cli.ts:6) — also one-way.

### Maintainability
- `runInstallHook` is 56 lines (133-189). On the long side, but the body is mostly a flat decision table; splitting it is unlikely to clarify.
- **Local `UserError` (line 6-8) is a duplicate** of the canonical class in `cli.ts:51-53`. The duck-typed handler in `cli.ts:891-895` accepts any `{exitCode: number}`, so this works, but it spreads the error-class taxonomy across modules. `status.ts` and `commands/sync.ts` carry the same duplicate. (See Specific issues.)
- File-write is **not atomic**: `writeSettings` (line 108-111) does a direct `writeFile` — a crash mid-write leaves a truncated `settings.json`. For a file the user almost certainly cares about, write-temp-and-rename would be safer.
- The verb-rendering ternary chain (lines 175-182) is hard to read; a small `verbFor(action)` lookup or a `Record<Action, string>` would flatten it.
- Magic string `'startup|resume|clear'` for the matcher (line 128) is undocumented — a one-liner comment explaining why those three events would help.
- `HOOK_SCRIPT_BODY` says "Kept in sync with the human-readable copy at `scripts/hook.sh`" (line 56-57) but there is no test or build step that enforces parity. Drift is a real risk.

### Style
- The local `HookCommand` / `SessionStartBlock` / `ClaudeSettings` declarations (lines 35-51) are duplicated verbatim in `uninstall-hook.ts:21-37`. Should live in a shared module (e.g. `lib/hookSettings.ts` or `lib/types.ts`).
- Comment on line 26 marks `claudeHome` "tests + --claude-home flag" — good intentional documentation of the override rationale.
- `chain?: boolean` and `force?: boolean` are typed as optional booleans but consistently checked with `=== true`. That's safe but verbose; either drop the optionality (default `false`) or stop the `=== true` ceremony.

## Specific issues
- `src/commands/install-hook.ts:6-8` — duplicate `UserError` class with no shared base. Same body in `cli.ts:51`, `commands/status.ts:13`, `commands/sync.ts:18`. The duck-typed `classifyAndExit` in cli.ts (lines 891-895) means this works, but a single shared `class UserError extends Error` exported from `lib/errors.ts` would eliminate four copies and make the contract explicit.
- `src/commands/install-hook.ts:35-51` — three internal interfaces (`HookCommand`, `SessionStartBlock`, `ClaudeSettings`) are copy-pasted into `uninstall-hook.ts:21-37`. Drift between them is silent.
- `src/commands/install-hook.ts:108-111` — `writeSettings` is not crash-safe. A power-loss or `^C` between truncate and write leaves `settings.json` empty or short, breaking Claude Code on next start. Use `writeFile` to a sibling temp + `rename`.
- `src/commands/install-hook.ts:101` — `JSON.parse(text)` cast to `ClaudeSettings`: no validation, malformed JSON throws a generic message that gets re-wrapped. If a user has hand-edited `settings.json` and broken it, the error is "Failed to read … : Unexpected token" — readable enough but doesn't suggest "your settings.json is corrupt".
- `src/commands/install-hook.ts:152` — when an existing ccpp block is found, the code unconditionally overwrites it with the freshly computed block (action=`'updated'`) **even if the new `scriptPath` differs from the old one**. That's intentional (handles `CCPP_HOME` changes) but undocumented; the user just sees "updated". A short comment helps.
- `src/commands/install-hook.ts:122` — `shellQuote`'s allow-list omits some POSIX-safe chars (`,`, `=`) but covers the common case. Not a bug; flagging because it'd matter if someone passed `--ccpp-home /tmp/dir,with,commas`.
- `src/commands/install-hook.ts:75-79` — `defaultCcppHome` reads `process.env.CCPP_HOME` directly. There's no override mechanism in tests for "what if CCPP_HOME is set in the test environment"; tests rely on `opts.ccppHome` always being passed. Worth a `delete process.env.CCPP_HOME` in `beforeEach` for hygiene, or push env-reading into a single helper.
- `HOOK_SCRIPT_BODY` (lines 58-73) ↔ `scripts/hook.sh` parity has no automated check. Add a one-line test: `expect(HOOK_SCRIPT_BODY).toBe(readFileSync('scripts/hook.sh','utf8'))`.

## Suggestions
- **[high]** Centralise the error taxonomy. Move `UserError`, `EnvError`, `CollisionError` to `src/lib/errors.ts`; have `cli.ts`, `install-hook.ts`, `uninstall-hook.ts`, `status.ts`, `commands/sync.ts` import from there. Removes four duplicates and makes the duck-typed handler in `cli.ts:891` redundant (a single `instanceof` check would do).
- **[high]** Extract the shared settings-shape types and the `read/writeSettings` helpers into `src/lib/claudeSettings.ts`. Both hook commands need exactly the same `ClaudeSettings` / `SessionStartBlock` / `HookCommand` shape and the same read/write semantics. Right now they're literally copy-pasted (install-hook.ts:35-51 ↔ uninstall-hook.ts:21-37; install-hook.ts:98-111 ↔ uninstall-hook.ts:39-51).
- **[high]** Make `writeSettings` atomic: write to `${path}.tmp` then `fs.rename`. `~/.claude/settings.json` is a high-stakes file — corruption breaks every Claude Code session.
- **[medium]** Add a parity test pinning `HOOK_SCRIPT_BODY` to `scripts/hook.sh`. Drift today is silent.
- **[medium]** Replace the verb ternary chain (lines 175-182) with a `const ACTION_VERB: Record<Action, string>` map.
- **[low]** Document the `'startup|resume|clear'` matcher (line 128) — why those three events.
- **[low]** Drop the `=== true` ceremony for the `chain` / `force` / `quiet` / `json` boolean options; either default them in the type or treat them as plain booleans.

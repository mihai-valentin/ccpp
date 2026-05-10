# Module: src/cli.ts

**LoC**: 387  •  **Test file**: no — exercised end-to-end via `tests/cli.test.ts` (spawn-based). No unit test for `classifyAndExit`.  •  **v0.2.2 status**: refactored (was 1093 LoC; ~64% reduction)

## Purpose
Entry point and argv-wiring layer. Parses `process.argv` with `cac`, registers every subcommand with a uniform option set (`attachCommonOptions`), translates parsed flags into typed `runX` opts (the `do*` glue functions), and classifies thrown errors into exit codes (`classifyAndExit`).

## Public surface
- No `export` declarations — module is its own entry point. The bottom-of-file `main(process.argv).catch(classifyAndExit)` (line 387) runs at import time.
- Implicitly exports the CLI binary contract (subcommand names, flags, exit codes, version string).

## Strengths
- The split landed cleanly. The file is now ~390 LoC of pure wiring + glue + classifier; no domain logic survives. The previous v0.2.1 cohesion finding ("does too many things") is fully resolved.
- Subcommand registration is uniform (lines 220–358): every `cli.command(...)` chain is wrapped in `attachCommonOptions(...)`, so `--claude-home`, `--config`, `--lockfile`, `--project`, `--json`, `--quiet`, `--no-color` are guaranteed on every verb.
- Errors are unified through a single `lib/errors.ts` (line 13). `classifyAndExit` (lines 198–214) uses real `instanceof` checks, not duck-typing — a clear win over the v0.2.1 design.
- Version inlining via tsup `define` (`__VERSION__`, lines 22, 218) eliminates the `__dirname` + `package.json` read; the inlined-comment block at 17–22 names the design choice.
- The `do*` glue functions all follow one pattern: build a typed `Parameters<typeof runX>[0]` object, conditionally attach optional flags, then call. Uniform enough that drift between subcommands is unlikely.
- `cli.command('', 'Show help')` (line 363) now carries the explanatory comment the v0.2.1 review asked for (lines 360–362).

## Concerns

### Cohesion
Cleanly bounded. Three concerns coexist — option attachment (24–40), glue handlers (44–194), error classification + `main` (196–385) — and each is structurally separated by section comments (lines 42, 196). Nothing here is out of place.

### Coupling
- Imports nine sibling modules (`commands/*`) plus `lib/config`, `lib/errors`, `lib/lockfile`, `lib/term` (lines 1–15). For a CLI entry point this is appropriate — the file is a switchboard. No transitive lib coupling: every reach into `lib/*` is now via a `commands/*` indirection except the legitimately shared `errors`, `term`, and the two filename constants.
- Two filename constants are imported (`CONFIG_FILENAME` at 12, `LOCKFILE_FILENAME` at 14) but only `CONFIG_FILENAME` is referenced in this file (lines 29, 34). `LOCKFILE_FILENAME` is dead — see Specific issues.
- `HookScope` is imported as a type from `commands/install-hook.js` (line 4) and used in `doInstallHook` and `doUninstallHook` (lines 126, 140). Reasonable — keeps the scope literal in one place.

### Maintainability
- The `do*` glue functions are repetitive on purpose. Every one rebuilds the `runX` opts object with conditional `if (opts.x !== undefined) runOpts.x = opts.x;` lines. This is a deliberate consequence of the project's `exactOptionalPropertyTypes` discipline — assigning `undefined` would type-error against `runX`'s `?:` declarations. The repetition is annoying but locally correct; abstracting it would either lose type safety or require generic helpers that aren't worth the cost given the surface is small (six glue functions).
- `doSync` (85–120) is the longest glue at ~36 lines and contains a small piece of validation logic — the `--trigger` enum check (lines 112–117). That belongs inside `runSync`'s opts parsing, not in the wiring layer. It's the only piece of non-glue logic that crossed the line during the extract.
- `doConfig` (167–194) is the only handler that wraps the `runConfig` call in a try/catch and re-wraps any error as `UserError` (lines 191–193). That's bypassing the classifier — a thrown `EnvError` from `runConfig` would silently get reclassified to exit 1. The other glue functions let errors propagate untouched. Either there's a deliberate reason `runConfig` errors are always user errors (in which case `runConfig` should throw `UserError` itself), or this is a leftover from before `lib/errors.ts` existed.
- `attachCommonOptions` (24–40) keeps the v0.2.1 generic-T constraint that loses the `cac` Command type after the call. It still forces the awkward "build the chain *inside* the call" pattern at every registration site (220–358). Not worth fixing — works fine, just not graceful.
- The regex-on-`cac`-error-message kludge in `classifyAndExit` (line 206) survives from v0.2.1 with no test pinning it. If `cac` ever rephrases "missing required args" or "unknown option", exit-1 silently becomes exit-2. Same finding as v0.2.1.
- `let code: number = EXIT.ENV;` (line 199) widens the literal type — same minor finding as v0.2.1, still applies.

### Style
- Section divider comments (`/* -------------------- ... -------------------- */`) at 42, 196 navigate well at this size.
- All `do*` functions have implicit `void` Promise returns and are individually short (10–50 lines). Consistent.
- The glue duplication idiom (`if (opts.x === true) runOpts.x = true;`) appears 25+ times across `doInit`, `doInstall`, `doSync`, `doInstallHook`, `doConfig`. It's correct but mechanical — a reader has to scan past each block to find any meaningful divergence between handlers.
- No dead-code or copy-paste outside the noted `LOCKFILE_FILENAME` import.

## Specific issues
- **cli.ts:14** — `LOCKFILE_FILENAME` is imported but never referenced anywhere in the file. Unused import; biome's organize-imports should flag this on next run.
- **cli.ts:112–118** — `--trigger` enum validation lives in `doSync`. This is the only non-glue branch in any handler; push it down into `runSync`'s validation so the wiring layer is purely declarative.
- **cli.ts:191–193** — `doConfig` wraps `runConfig` errors in `UserError`. If `runConfig` throws an `EnvError` (e.g. unreadable config file), it gets reclassified silently. Either drop the wrapper or make it kind-aware (`if (err instanceof EnvError) throw err;`).
- **cli.ts:199** — `let code: number = EXIT.ENV;` widens the `as const` literal type; use `let code: ExitCode = EXIT.ENV;` for stronger typing.
- **cli.ts:206** — `/^missing required args/i.test(message)` and `/^unknown option/i.test(message)` reach into `cac`'s internal error text with no test pinning it. Add a unit test that exercises `classifyAndExit` directly with these messages.
- **cli.ts:212** — `process.stderr.write(`${red('✗')} ${message}\n`)` writes a colored prefix unconditionally. If `--no-color` was passed, `disableColor()` only fires inside `commonPaths`, which means `attachCommonOptions` parsed it but the classifier ran *before* any handler invoked `commonPaths` (e.g. on argv parse errors). On those paths the `✗` is colored even with `--no-color`. Minor — ANSI is short-circuited by `colorEnabled()` reading `NO_COLOR` from env, so it's only an issue when the user passed only the flag.
- **cli.ts:367–381** — `cli.help()` is called twice (367 and 370). The second call replaces the help renderer to add the Exit-codes section; the first registers the default. Functionally fine but slightly wasteful — drop the bare `cli.help()` at 367 since 370 supersedes it.
- **cli.ts:383–384** — `cli.parse(argv, { run: false }); await cli.runMatchedCommand();` is the standard cac pattern but undocumented here. A one-line comment explaining why `run: false` is required for async actions would aid the next maintainer.

## Suggestions
- **[medium]** Push `--trigger` validation down into `runSync` (cli.ts:112–117). Wiring layer should be declarative.
- **[medium]** Drop the blanket `UserError` wrapper around `runConfig` in `doConfig` (cli.ts:191–193) or make it kind-aware.
- **[medium]** Add a unit test for `classifyAndExit` covering `UserError`, `EnvError`, `CollisionError`, generic `Error`, and the two regex branches at line 206. The classifier is the binary's user contract and currently has no direct coverage.
- **[low]** Remove the unused `LOCKFILE_FILENAME` import (cli.ts:14).
- **[low]** Tighten `let code: number` to `let code: ExitCode` (cli.ts:199).
- **[low]** Drop the redundant first `cli.help()` call (cli.ts:367).
- **[low]** Comment the `cli.parse(argv, { run: false })` + `runMatchedCommand()` idiom (cli.ts:383–384).

## Resolved from v0.2.1
- File split into `commands/{init,install,list,uninstall}.ts` plus `commands/shared.ts` — confirmed.
- Single `lib/errors.ts` with shared `UserError` / `EnvError` / `CollisionError` / `EXIT` — confirmed (line 13). Duck-typing in classifier replaced with `instanceof` (line 201).
- `__VERSION__` build-time inline replaces `readPkgVersion` + `__dirname` — confirmed (lines 22, 218).
- `validateInstallFlags` consolidated — moved to `commands/install.ts`.
- `formatCollisionMessage` no longer duplicated between cli.ts and sync.ts.
- `isInteractive` and `stripColor` moved to `lib/term.ts`.
- `SHORT_SHA_LEN` / `formatShortSha` centralised — confirmed.
- `cli.command('', ...)` empty-name idiom now commented (lines 360–362).

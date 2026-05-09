# Module: src/cli.ts

**LoC**: 1070  •  **Test file**: no — there is no `src/cli.test.ts`. The CLI surface is exercised only by spawn-based integration tests (`tests/...`).

## Purpose
Entry point and orchestrator. Parses argv with `cac`, defines every subcommand, holds shared option plumbing (`commonPaths`, `attachCommonOptions`), implements three subcommands inline (`init`, `install`, `list`, `uninstall`) and delegates the rest to `src/commands/*`. Also defines the top-level error taxonomy (`UserError` / `EnvError` / `CollisionError`) and the exit-code classifier.

## Public surface
- No `export` declarations. The module is its own entry point — the bottom-of-file `main(process.argv).catch(classifyAndExit)` (line 1070) runs at import time. That means importing this file from anywhere else would re-run the CLI, but nothing currently does.

## Strengths
- Subcommand registration is uniform: every command goes through `attachCommonOptions(...)` (lines 912–1044), so `--claude-home`, `--config`, `--lockfile`, `--json`, `--quiet`, `--no-color` are guaranteed to exist on every verb.
- `installSource` (lines 210–301) is a deliberate factor-out shared by both the URL-arg `doInstall` path and the wizard path; the comment on line 205–209 names this intent. Persistence ordering is consistent (lockfile written even on collision, line 264) so the source pin survives an aborted install.
- Exit-code constants (`EXIT`, line 49) are documented to be in sync with `--help` epilog and `docs/exit-codes.md`. The contract is single-sourced in code.
- Interactive vs. scripted vs. JSON modes are negotiated explicitly per subcommand (e.g. lines 355–358, 396–398) rather than hidden inside the prompt helpers.
- The duck-typed `exitCode` reader in `classifyAndExit` (lines 888–906) is a pragmatic fix for sub-modules defining their own error classes — and the comment at 892–894 names the design choice.

## Concerns

### Cohesion
This file does too many things. At ~1070 lines it is the largest in the repo and mixes:

- Error class definitions (51–64)
- Common-option plumbing (66–137)
- Subcommand implementations: `doInit` (139–167), `doInstall` (303–363), `doInstallInteractive` (414–484), `doSync` (517–552), `doInstallHook` (554–568), `doUninstallHook` (570–579), `doStatus` (581–589), `doList` (591–624), `doUninstall` (626–669), `doConfig` (671–698)
- Domain helpers: `installSource` (210–301), `applyPreferLatest` (371–394), `interactiveConflictResolver` (494–515), `resolveSourceForUninstall` (700–715), `lockfileRows` (726–771)
- Presentation: `emitInstallSummary` (788–813), `emitWizardReport` (827–881), `formatCollisionMessage` (773–786), `stripColor` (883–886)
- argv wiring inside `main` (908–1068)

`doInstall` / `doInstallInteractive` / `installSource` / `applyPreferLatest` / `interactiveConflictResolver` together are an "install" feature spanning ~310 lines that belongs in `commands/install.ts` next to `install-wizard.ts`. The same is true for `doList` + `lockfileRows` + `ListRow` (~80 lines, a list feature), `doUninstall` + `resolveSourceForUninstall` (~90 lines), and `doInit` (~30 lines).

The action handler pattern is also inconsistent: `sync`, `install-hook`, `uninstall-hook`, `status`, `config` are thin shims that build a typed `runX` opts object and delegate to `commands/*`; `init`, `install`, `list`, `uninstall` are implemented inline against `lib/*` directly. There is no principle visible in the code for which side a subcommand falls on — it is historical drift.

### Coupling
- Imports from every sibling module: `commands/config`, `commands/install-hook`, `commands/install-wizard`, `commands/status`, `commands/sync`, `commands/uninstall-hook`, plus six `lib/*` modules (lines 5–46). For an entry point this is appropriate, but the inlined subcommands also reach into `lib/git`, `lib/installer`, `lib/lockfile`, `lib/manifest`, `lib/config` directly — coupling that would disappear if those subcommands lived in their own `commands/*` files.
- `cli.ts` and `commands/sync.ts` both define `UserError` / `EnvError` / `CollisionError` (cli.ts:51–64, sync.ts:18–31) with identical shapes. `commands/install-hook.ts` and `commands/status.ts` redefine `UserError` again. The `classifyAndExit` duck-type is a workaround for the fact that there is no shared `lib/errors.ts`. Four copies of the same class is a real maintenance hazard — the moment one diverges (e.g. someone adds a `code` field), the classifier silently degrades.
- `import { CONFIG_FILENAME, ... }` is duplicated across two import statements at lines 16–22 and 23–29 (both pull from `./lib/config.js`). Stylistically a single combined import would suffice; biome-format won't fix this because they import disjoint symbols.
- `__dirname` (line 121) — fine for the CJS build target but mildly fragile if the bundler is ever switched to ESM. Worth a comment.

### Maintainability
- `installSource` is 92 lines (210–301) and has four conflict-handling branches (252–282). Extracting `handleConflicts(result, ...)` would shrink it and let conflict logic be unit-tested independently.
- `doInstall` (303–363) is 60+ lines with three conditional pre-validation branches (313–342) before the main work begins. The `--prefer-latest + --scratch` mutual-exclusion check (317–321) is the kind of validation that belongs in a dedicated `validateInstallFlags` helper; same for `doInstallInteractive`'s analogous bundled check at 423–433.
- `doInstallInteractive` has its own `existing` config flow that re-creates an empty config (lines 450–460) where the non-interactive path uses `readConfig` (327–328). Two slightly different "make sure we have a config to write" code paths live within 100 lines of each other.
- `lockfileRows` (726–771) duplicates structural knowledge that should live in one place — it independently classifies install entries by destination directory, but `commands/install-wizard.ts:152` (`summarizeInstalledTargets`) does the *same* classification with a *different* shape. Both are open to drift if the on-disk layout changes.
- `stripColor` (883–886) is a one-shot ANSI stripper used only by `doList`. It belongs in `lib/term.ts` next to the color helpers it inverts.
- Magic strings — sha-7-truncation (`.slice(0, 7)`) appears at lines 611, 806, 849, 270/271 in sync.ts. Would benefit from a `SHORT_SHA_LEN = 7` constant.
- Error handling style is inconsistent: some calls use `.catch((err: Error) => { throw new UserError(err.message); })` (e.g. 593, 631), others wrap in `try/catch` (327–331), others use `(err) => throw new EnvError(...)` (217–221). All three reach the same destination, but the difference adds noise.
- `attachCommonOptions` returns a generic `T` constrained only to `{ option(...): T }` (line 128). That is enough to keep chaining alive, but it loses the `cac` Command type so callers cannot chain anything else after `attachCommonOptions(...)`. Every call site shows this pattern: build the chain *inside* the call, then attach. It works but it is awkward and forces every subcommand registration into a deeply nested expression (lines 912–921, 923–948, etc.).
- `readPkgVersion` (119–126) reads `package.json` from `__dirname/..` synchronously every CLI invocation. That is a fixed cost (~few ms) but it would be cleaner to inline the version at build time via tsup `define`.

### Style
- `formatCollisionMessage` is defined twice — once here at line 773–786 and once in `commands/sync.ts:404–413` with a slightly different signature (the cli.ts version takes `incomingSource`). Same intent, two implementations.
- `interactiveConflictResolver` (494–515) writes to `process.stderr` even though most other interactive prompts go through `term.ts` helpers that print to stderr too — the consistency is OK, but the function bypasses the `log()` wrapper used elsewhere, so `--quiet` does not silence the conflict UI.
- The doc comment on line 184 (`/** If true, skip writing to ccpp.config.json. */`) describes the field as `scratch` — a name that mirrors the user-facing `--scratch` flag. Good naming, but inside `installSource` it is used as `params.scratch` and shadowed by the destructured local of the same name. The scratch=true behavior is a single inverted check at line 287, so a clearer name would be `writeConfig: boolean`.
- The `cli.command('', 'Show help')` empty-string-named command (1046–1048) is a `cac` workaround — worth a `// no args → help` comment.
- `forcePreferIncoming` (line 186) is set to `Boolean(opts.prefer) || Boolean(opts.yes)` (line 349). That conflates two semantically different flags: `--prefer` is "I'm telling you who wins on collision", `--yes` is "auto-accept all prompts". They happen to align here because `--yes` implies "skip the conflict prompt by picking incoming" — but a reader has to puzzle that out. A short comment at 349 would help.

## Specific issues
- **cli.ts:51–64 vs. sync.ts:18–31**: `UserError`/`EnvError`/`CollisionError` are duplicated verbatim. The classifier (888–906) papers over this with duck-typing, but two divergent definitions is a bug-in-waiting.
- **cli.ts:16–29**: two consecutive imports from `./lib/config.js`. Merge into one statement.
- **cli.ts:121**: `__dirname` assumes CJS output. If/when tsup is reconfigured for ESM, this breaks silently because the catch returns `'0.0.0'` — version regression won't show up until release time.
- **cli.ts:231–233**: `existing?.preferredSources ? { ...existing.preferredSources } : {}` — fine, but note that on `existing===null` we still build a fresh map. The same default appears at sync.ts:240 — extract a `getPreferredSources(config)` helper.
- **cli.ts:258–266**: lockfile is written *before* `CollisionError` is thrown so the source pin is recorded, but only on the no-resolver / cancel branches, not on the `!resolveConflicts && !forcePreferIncoming` branch (263–266) — actually it *is* written there too. The double-write across the two paths could be one `await writeLockfile(...)` before the if-chain.
- **cli.ts:269–282**: after conflict resolution, `applyManifest` is called a second time and the result fields are mutated by `push(...retry...)`. This means `result.installed` ends up with concatenated arrays from both passes that may double-count entries that existed in the first pass — the `Set<string>` discipline used in `runSync` (sync.ts:249) is missing here. Likely benign because the first pass produces empty `installed` for items in conflict, but it is a non-obvious invariant.
- **cli.ts:317–321** and **cli.ts:423–433**: two separate flag-combination guards that should converge into one `validateInstallFlags` to avoid drift.
- **cli.ts:396–398**: `isInteractive` is defined here and used four times; `term.ts` would be a natural home so all interactive helpers share one TTY definition.
- **cli.ts:654**: `config.sources = config.sources.filter(...)` mutates the loaded config; that is fine because it is then written, but it is the only place in the file that mutates a loaded `CcppConfig` after read. Other paths build a new object or push.
- **cli.ts:700–715**: `resolveSourceForUninstall` swallows `parseRepoUrl` errors silently (706–708). Acceptable behavior but worth a comment beyond "ignore parse failures" — namely, that a malformed URL in the lockfile should not block uninstalling a *different* source by name.
- **cli.ts:773–786 + sync.ts:404–413**: two `formatCollisionMessage` implementations. Consolidate.
- **cli.ts:883–886**: `stripColor` is general-purpose and belongs in `lib/term.ts`.
- **cli.ts:889**: `let code: number = EXIT.ENV;` — declaring as `number` widens what would otherwise be a literal type from the `as const` map. Use `let code: (typeof EXIT)[keyof typeof EXIT] = EXIT.ENV;` or just `let code = EXIT.ENV as number;`.
- **cli.ts:898**: `/^missing required args/i.test(message)` and `/^unknown option/i.test(message)` reach inside `cac`'s error message text. If `cac` ever rephrases, exit 1 silently becomes exit 2. There is no test guarding this. A small unit test mocking `cac`'s error format would protect this contract.
- **cli.ts:1046**: `cli.command('', 'Show help')` — undocumented `cac` idiom, worth a comment.

## Suggestions

- **[high]** Extract `lib/errors.ts` exporting `UserError`, `EnvError`, `CollisionError` and the `EXIT` map. Replace the four redefinitions in `cli.ts:51–64`, `sync.ts:18–31`, `install-hook.ts:6`, `status.ts:13`. Drop the duck-typing in `classifyAndExit` and switch to `instanceof` checks.
- **[high]** Split this file. Move `doInit`, `doInstall*`, `installSource`, `applyPreferLatest`, `interactiveConflictResolver`, `formatCollisionMessage` into `src/commands/install.ts`. Move `doList` + `lockfileRows` + `ListRow` into `src/commands/list.ts`. Move `doUninstall` + `resolveSourceForUninstall` into `src/commands/uninstall.ts`. Cli.ts becomes ~250 lines of pure argv-wiring + classifier.
- **[high]** Once `installSource` lives in its own module, write unit tests for it. The collision retry path (cli.ts:268–282) has no direct tests today.
- **[medium]** Add `SHORT_SHA_LEN = 7` to `lib/term.ts` (or wherever a `formatSha(s)` helper lives). Replace the four `.slice(0, 7)` call sites.
- **[medium]** Move `isInteractive` and `stripColor` to `lib/term.ts` so every subcommand uses one TTY check and one ANSI stripper.
- **[medium]** Replace the two flag-validation blocks at 317–321 and 423–433 with a single `validateInstallFlags(opts)` that returns nothing on success and throws a `UserError` listing the bad combination.
- **[medium]** Inline package.json version at build time via `tsup --define __VERSION__=...`. Drops `readPkgVersion` and the `__dirname` dependency.
- **[low]** Merge the two `./lib/config.js` import statements at lines 16–29 into one.
- **[low]** Rename `scratch` → `writeConfigToDisk` (inverted) on `InstallSourceParams` and at the call sites; the current name is the flag name, not the field's effect.
- **[low]** Replace the regex-on-`cac`-error-message kludge at 898 with explicit detection (e.g., subclass `cac` or pre-validate). At minimum add a unit test pinning the exit-code-from-message contract.
- **[low]** Annotate `cli.command('', 'Show help')` (1046) with a one-line comment explaining the `cac` empty-name idiom.

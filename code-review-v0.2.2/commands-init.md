# Module: src/commands/init.ts

**LoC**: 44  •  **Test file**: no — only spawn-based coverage via `tests/cli.test.ts`. No `commands/init.test.ts`.  •  **v0.2.2 status**: new (extracted from cli.ts)

## Purpose
Implements `ccpp init`. Creates a fresh `ccpp.config.json` at the resolved configPath, optionally seeded with one source from `--source` (with optional `--ref`).

## Public surface
- `RunInitOpts` (line 6) — extends `ResolvedCommon` with `source?`, `ref?`, `force?`.
- `runInit(opts)` (line 19) — async void; throws `UserError` on existing-file collision unless `--force`.

## Strengths
- Tight and linear (44 lines). Reads top-to-bottom: precondition check → build config → optional source seed → write → emit.
- Reuses `resolveSourceUrlAndRef` from `shared.ts` (line 28) instead of re-implementing the URL/ref reconciliation that previously lived in `cli.ts`.
- Both human and JSON output paths render the same data (lines 34–43); the JSON branch is a pure stringify, no formatting drift risk.
- Doc comments on the interface and the function (lines 7–12, 15–18) clearly state the seed-source behaviour and the force semantics.
- `ConfigSource` build (lines 29–31) follows the same pattern as `commands/install.ts:204–206` — declare with required fields, conditionally attach optional ones. Consistent with `exactOptionalPropertyTypes` discipline.

## Concerns

### Cohesion
Excellent. One responsibility, one function, one helper-free implementation.

### Coupling
- Imports `lib/config` (`ConfigSource`, `configExists`, `emptyConfig`, `writeConfig`), `lib/errors` (`UserError`), `lib/term` (`dim`, `green`), and `commands/shared` (`ResolvedCommon`, `log`, `resolveSourceUrlAndRef`). All necessary — no excess.
- No reach into `lib/git`, `lib/lockfile`, `lib/installer`, or any other sibling command. `init` truly does only init work.

### Maintainability
- The `resolved !== null` ternary at line 38 (`first source: ${resolved.url}${resolved.ref ? '@${resolved.ref}' : ''}`) duplicates the `<url>@<ref>` rendering format that `emitInstallSummary` and `emitWizardReport` in `commands/install.ts` build inline (e.g. install.ts:455, 500). A small `formatSourceRef(url, ref?)` helper would centralise the format, but at three call sites and one trivial format, this is borderline — flag low only.
- Error wrapping is consistent with the rest of the codebase: `UserError` for the "won't overwrite" precondition (line 21). No try/catch needed since `writeConfig` already throws structured errors.

### Style
- Naming is consistent: `opts`, `config`, `resolved`, `src`. No surprises.
- `await configExists(...)` happens unconditionally even when `--force` is set, then the boolean drives the throw. Fine — the call is cheap.
- The JSON branch (line 35) writes the entire config object, including the seeded source if any. The human branch shows only the URL+ref summary. The shapes intentionally differ; consumers of `--json` get the structured config they can re-parse.

## Specific issues
- **commands/init.ts:39** — string interpolation duplicates a `<url>@<ref>` formatter that exists implicitly in three other places. Minor; consider a shared `formatSourceRef` helper if a fourth caller appears.
- **commands/init.ts:34** — JSON output uses raw `process.stdout.write` rather than `log(...)`. Acceptable here because `--quiet` should arguably *not* suppress JSON output (the whole point of `--json` is machine consumption), but the asymmetry is implicit. Worth a one-line comment confirming that `--json` ignores `--quiet`.
- No unit test for `runInit` itself. The forced-overwrite branch and the `--source` + `--ref` matrix would be useful unit-test material — both are pure-ish (filesystem + console only).

## Suggestions
- **[low]** Add a `commands/init.test.ts` covering the four cases: no-source, `--source` only, `--source` + matching `--ref`, existing file without `--force` (throws).
- **[low]** Add a one-line comment at line 34 noting that `--json` deliberately ignores `--quiet`. Same idiom appears in `runList` and the `installSource` outputs — a one-time documented rule beats four call-site rationales.
- **[low]** Centralise `<url>@<ref>` formatting if/when a fourth call site appears.

## Resolved from v0.2.1
- The `doInit` handler (cli.ts ~139–167 in v0.2.1) became this module — clean extract, no logic leaked back. The "URL/ref reconciliation duplicated with doInstall" finding is resolved by `resolveSourceUrlAndRef` in `shared.ts`.

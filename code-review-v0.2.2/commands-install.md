# Module: src/commands/install.ts

**LoC**: 534  •  **Test file**: no — there is no `commands/install.test.ts`. `installSource`'s collision retry path (a v0.2.1 high-priority "needs unit tests" finding) is still uncovered by direct unit tests; behaviour is exercised only end-to-end via `tests/cli.test.ts`.  •  **v0.2.2 status**: new (extracted from cli.ts)

## Purpose
Implements `ccpp install` — both the explicit-URL form (`runInstall`) and the no-URL first-time wizard form (`runInstallInteractive`). Owns the shared install pipeline (`installSource`), the `--prefer-latest` policy gate (`applyPreferLatest`), the interactive collision UI, the `formatCollisionMessage` builder, the flag-combination validator, and the two emitters for human-readable / JSON output.

## Public surface
Types/interfaces:
- `InstallResult` (40)
- `InstallSourceParams` (48)
- `InstallSourceOutcome` (69)
- `RunInstallOpts` (84)
- `RunInstallInteractiveOpts` (89)

Functions:
- `runInstall(opts)` (129) — URL-arg path.
- `runInstallInteractive(opts)` (180) — wizard path.
- `installSource(params)` (241) — shared pipeline.
- `applyPreferLatest(config, url, yes)` (350) — policy persistence.
- `interactiveConflictResolver(conflicts, incomingUrl)` (396) — TTY collision UI.
- `formatCollisionMessage(conflicts, incomingSource)` (419) — error-text builder.

Plus internal helpers `validateInstallFlags` (102), `realWizardIO` (379), `emitInstallSummary` (437), `emitWizardReport` (477).

## Strengths
- The extract from `cli.ts` is mostly clean: this module owns the entire install feature — both paths, the shared core, the helpers — and `cli.ts` reduced to glue. The cohesion gain is real.
- `installSource` (241–340) is the single shared pipeline both paths converge on. Its collision branches (lines 286–300) and the persistence-before-throw rule (lines 292, 298) are now stated once instead of twice.
- `validateInstallFlags` (102–122) consolidates the v0.2.1 dual flag-validation blocks into one helper that both `runInstall` and `runInstallInteractive` call. The high-priority v0.2.1 finding is resolved.
- Fixed a real v0.2.1 bug: when the URL-arg path runs without a pre-existing config, `installSource` now writes a config (lines 320–337). The comment at 322–326 explicitly names what the previous behaviour broke ("`ccpp sync` would error with No ccpp.config.json").
- Pure functions and helpers (`validateInstallFlags`, `formatCollisionMessage`, `applyPreferLatest`, `interactiveConflictResolver`) are individually exported, which makes them unit-testable in isolation — the v0.2.1 review explicitly asked for this. Whether tests have been written is a separate concern (see Concerns/Maintainability).
- `realWizardIO` (379–386) is a tiny adapter that walls `process.stdout`/`stderr` off behind the wizard's injectable `WizardIO` interface. Tests can drive `runInstallWizard` with a fake IO without spawning a child process — already used by `install-wizard.test.ts`.
- Section dividers (38, 91, 173, 233, 342) navigate the file at a glance.

## Concerns

### Cohesion
Mostly good — every export here is part of "install" — but the file is right at the edge of its appropriate size, and three internal sub-features could be argued to live elsewhere:

- **The wizard glue** (`runInstallInteractive` at 180–231 + `realWizardIO` at 379–386 + `emitWizardReport` at 477–534) ties this module to `commands/install-wizard.ts` and to `runInstallHook` from `commands/install-hook.ts` (line 29). The wizard-specific report builder is 60 lines of presentation code that's not shared with the URL-arg path. Worth considering whether `runInstallInteractive` belongs as a thin shim in this file with the body moved into `commands/install-wizard.ts` — the wizard module already owns the WizardIO/WizardPlan types.

- **`interactiveConflictResolver`** (396–417) is a presentation-layer function (writes to stderr, calls `promptChoice`) that lives inside the install module. Both `installSource` paths use it via the `resolveConflicts` injection seam, which is good — but if/when a future feature also needs collision resolution (e.g. `sync` adopts the same UX), this should move to a `commands/collisions.ts` or stay here under a clear "exported for sync.ts to use" comment.

- **`formatCollisionMessage`** (419–435) is a pure error-text builder used only by `installSource`. It's small enough that co-location is fine.

### Coupling
- Imports nine `lib/*` modules — `lib/config`, `lib/errors`, `lib/git`, `lib/installer`, `lib/lockfile`, `lib/manifest`, `lib/term`, `lib/types` — and three `commands/*` siblings (`install-hook`, `install-wizard`, `shared`). For "the module that owns the entire install pipeline", this is the expected fan-in.
- The dependency on `commands/install-hook.ts` (line 29) is wizard-specific (line 222–227 calls `runInstallHook`). It's the only place `commands/install.ts` reaches sideways into another command. Wizard-only concern; would dissolve if `runInstallInteractive` moved to `install-wizard.ts`.
- `cloneOrUpdate` is imported from `lib/git` and its return type is referenced via `Awaited<ReturnType<typeof cloneOrUpdate>>` (lines 70, 247, 467). That works but couples this module's public types to `lib/git`'s return shape. Naming the synced-clone result type explicitly in `lib/git` and importing it would harden the boundary.

### Maintainability
- File length (534 LoC) is at the upper edge of comfortable. The split is structurally sound, but if `runInstallInteractive` + `emitWizardReport` were peeled off (~120 lines), the remaining install-core would be ~400 LoC and easier to keep in a single mental model.
- `installSource` (241–340) is 100 lines and has four collision-handling branches (lines 286, 289, 297, plus the "no conflicts" implicit fall-through). The v0.2.1 review asked for an extracted `handleConflicts(...)` helper; this didn't happen. The branches are still readable as a flat if/else chain, but they share two pieces of mutable state (`preferredSources`, `conflictsResolved`) that the helper extraction would have made explicit.
- The "lockfile written before throwing CollisionError" rule appears twice (lines 292 and 298) with nothing in code linking them. A reader has to recognise that these are redundancies on purpose. A one-liner comment block above the if/else chain stating the invariant ("we always persist the source pin before raising a collision") would help.
- `applyManifest` is called twice on the conflict-retry path (once at 269, once at 303–310 with the resolved `preferredSources`). The retry's results are merged into the first pass's `result` via `push(...)` (lines 311–315). The v0.2.1 finding about double-counting in `result.installed` still applies — there is no `Set` discipline as in `runSync`. In practice the first pass yields empty `installed` for items that conflict, so duplicates shouldn't appear; but it's an undocumented invariant.
- `forcePreferIncoming: Boolean(opts.prefer) || Boolean(opts.yes)` (line 157) conflates `--prefer` and `--yes`. The v0.2.1 review flagged this; no comment was added explaining the conflation. The semantic relationship — "`--yes` implies skip the conflict prompt by picking incoming" — still has to be deduced by the reader.
- `RunInstallOpts` and `RunInstallInteractiveOpts` (84–89) both extend `ResolvedCommon` with `InstallFlags`. Nice consolidation. But the no-URL path's `runInstallInteractive` accepts every flag in `InstallFlags` only to immediately reject all of them inside `validateInstallFlags(opts, false)` (lines 103–115). That's a deliberate design — cac validates presence, not absence — but it means the type signature suggests flags are usable when they're not. A separate `RunInstallInteractiveOpts = ResolvedCommon` (no flags) would be more honest, with the flag rejection happening at the cac/cli boundary instead.
- Two literal call sites use `Boolean(opts.scratch)` / `Boolean(opts.prefer)` etc. (lines 156–158) where the type is already `boolean | undefined`. `opts.scratch === true` is the idiom used elsewhere in the file (e.g. lines 79, 117). Pick one — biome won't.
- `applyPreferLatest` (350–377) has a four-arm decision tree (autoAcceptAcks vs ack-already-recorded vs interactive vs throw). The "ack already recorded" branch (lines 362–364) is a dangling else-if with only a comment for a body. Functionally correct (no setOpts mutation needed), but it reads as a stub. A `// fall through — no setOpts changes needed` comment is there but the empty branch is unusual; an early `if (yes) { ... return write }` and falling through to `else if (ackKind === null)` could collapse the awkwardness.
- `emitWizardReport` (477–534) is 60 lines of layout glue. Acceptable for a report, but it's the kind of presentation code that drifts the moment a new field is added. No tests pin its output format.
- Direct `process.stderr.write` calls appear in `installSource` (line 258 — manifest warnings) and `interactiveConflictResolver` (lines 401, 405–407). They bypass `log()` so `--quiet` does not silence them. That's correct for warnings/prompts (they should go to stderr regardless of quiet), but the asymmetry is undocumented — same v0.2.1 finding.

### Style
- Section dividers are present and helpful (lines 38, 91, 173, 233, 342).
- The doc comments above each public function name the contract clearly (e.g. lines 91–101 for `validateInstallFlags`, 124–128 for `runInstall`, 233–240 for `installSource`, 388–395 for `interactiveConflictResolver`).
- `RunInstallOpts extends ResolvedCommon, InstallFlags` (84) — the multi-extends spelling is concise and idiomatic.
- The `Parameters<typeof runX>[0]` builder pattern (lines 67, 76, 152, 209, 244, 359) is used internally too, mirroring the cli.ts glue style. Consistent across the codebase.
- Magic-string warning prefix `${yellow('!')}` appears six times (lines 258, 402, 460, 512). Not wrong, but warrants a `WARN_PREFIX = yellow('!')` if a seventh appears.

## Specific issues
- **commands/install.ts:241–340** — `installSource` is 100 lines with four collision branches and shared mutable state. The v0.2.1 high-priority "extract `handleConflicts(...)` helper" finding is unresolved; consider a follow-up refactor that separates the resolve-or-throw decision from the retry-and-merge mechanics.
- **commands/install.ts:286–300** — the two `await writeLockfile(...)` calls (292, 298) before throwing `CollisionError` enforce a "always pin the source even on collision" invariant that has no docstring naming it. Add a one-line comment above line 286.
- **commands/install.ts:311–316** — `result.installed.push(...retry.installed)` etc. concatenate without dedup. The v0.2.1 double-counting concern still holds in theory; document the "first pass is empty for conflicts" invariant or use a `Set` like `runSync`.
- **commands/install.ts:157** — `forcePreferIncoming: Boolean(opts.prefer) || Boolean(opts.yes)` conflates two flags with different semantic intent. Add a comment naming the conflation rule.
- **commands/install.ts:222–228** — `runInstallInteractive` calls `runInstallHook` directly, creating a wizard→install-hook coupling that nothing else needs. If `runInstallInteractive` is hoisted into `install-wizard.ts`, this dependency goes with it.
- **commands/install.ts:362–364** — the empty `else if` branch with only a comment body is unusual. Restructure so the comment isn't load-bearing for the control flow.
- **commands/install.ts:156–158** — mix of `Boolean(opts.x)` and `opts.x === true` style. Standardize on one idiom across the file.
- **commands/install.ts:89** — `RunInstallInteractiveOpts = ResolvedCommon & InstallFlags` types every install-only flag as accepted, even though `validateInstallFlags(_, false)` rejects all of them. Misleading type. Consider `RunInstallInteractiveOpts = ResolvedCommon` and rejecting flags at the cli.ts glue layer.
- **commands/install.ts:419–435** — `formatCollisionMessage` accepts `incomingSource: string | null` and the `null` branch produces a generic message. Only `installSource` calls it (lines 293, 299) and always passes the URL — the `null` arm is dead. Either remove the parameter or document where the null path is intended for use.
- **No unit-test file** — high-priority v0.2.1 ask ("write unit tests for installSource"). The collision-retry path, the `--prefer-latest` ack flow, and `validateInstallFlags` are all unit-testable now that they're exported. Without these, the OSS release ships with the most-complex pipeline in the codebase covered only by spawn-based integration tests.

## Suggestions
- **[high]** Add `commands/install.test.ts` covering: `validateInstallFlags` matrix; `installSource` happy path / `--prefer` collision resolution / interactive collision resolution / cancel→CollisionError; `applyPreferLatest` ack/auto-ack/non-TTY; `interactiveConflictResolver` with mocked prompts; `formatCollisionMessage` shapes.
- **[high]** Extract the collision logic from `installSource` into a `resolveConflictsAndRetry(...)` helper that returns the merged result. Shrinks `installSource` from 100→~50 lines and makes the retry-merge invariant explicit.
- **[medium]** Move `runInstallInteractive` + `emitWizardReport` + `realWizardIO` into `commands/install-wizard.ts`. The wizard-specific report and IO adapter belong with the wizard state machine; the install module would lose its only sideways dependency on `install-hook.ts`.
- **[medium]** Document the "lockfile written before CollisionError" invariant with a comment block above lines 286–300.
- **[medium]** Replace `formatCollisionMessage`'s `incomingSource: string | null` with `string` and drop the unused null branch — or document who would call it with null.
- **[low]** Comment line 157 to spell out why `--yes` collapses into `forcePreferIncoming`.
- **[low]** Standardise on `opts.x === true` (or `Boolean(opts.x)`) across the file — current mix is inconsistent.
- **[low]** Restructure `applyPreferLatest`'s control flow so the empty-comment-body branch (362–364) goes away.

## Resolved from v0.2.1
- Single `validateInstallFlags` (102) — resolved.
- Build-time version inlining — handled in cli.ts; not in this module.
- `installSource` extracted into a separate file — resolved.
- `formatCollisionMessage` no longer duplicated with sync.ts — resolved (sync.ts now imports from here, or owns its own version; verify).
- `interactiveConflictResolver` extracted as exported helper — resolved.
- `applyPreferLatest` extracted as exported helper — resolved.
- "Re-run `ccpp install` writes config when none existed" bug — resolved (lines 320–337).

## Still open from v0.2.1
- Unit tests for `installSource`'s collision-retry path — still missing.
- `handleConflicts(...)` extraction — not done.
- `--prefer` vs `--yes` conflation comment — not added.
- Result-array dedup invariant — not documented or enforced.

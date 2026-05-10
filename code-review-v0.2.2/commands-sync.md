# Module: src/commands/sync.ts

**LoC**: 479  •  **Test file**: yes — `/home/mihai/xlnf/ccpp/src/commands/sync.test.ts` (293 LoC)  •  **v0.2.2 status**: refactored

## Purpose
Drives the `ccpp sync` subcommand: for every source in `ccpp.config.json` clone-or-update, parse the manifest, compute a changeset against `~/.claude/`, route through the apply gate (autoAccept / TTY / non-TTY / JSON / user-decline), apply or skip, and append a structured `sync.log` entry. Surfaces the `SyncReport` shape consumed by the CLI presenter and JSON output.

## Public surface
- **Types**:
  - `SyncOverride` (alias of `SyncPolicy`).
  - `SyncOverrideFlags` — the three CLI flags `--prefer-latest`, `--pinned`, `--update`.
  - `ApplyStatus` — `'applied' | 'no-changes' | 'skipped-no-prompt' | 'user-declined'`.
  - `RunSyncOpts`, `SourceSyncReport`, `SyncReport`.
- **Functions**:
  - `resolveOverride(flags): SyncOverride | undefined` — flag → policy collapse, throws `UserError` on conflicting flags (lines 83–94).
  - `runSync(opts): Promise<SyncReport>` — main entry (lines 111–162).

`effectivePolicy` and `effectiveAutoAccept` have been moved out to `lib/policy.ts` per the v0.2.1 review's medium-priority recommendation.

## Strengths
- **Decomposition is genuine.** `runSync` is now 52 body lines (111–162) versus 205 previously. Per-source logic is split into five named helpers — `syncOneSource` (180–219), `cloneAndParseSource` (226–253), `applySource` (259–332), `recordSkip` (339–378), `logSyncError` (381–392) — each with a focused doc comment that names its phase.
- **`SyncContext` (166–173) is a coherent reduction**, not a bag-of-state. Every field (`opts`, `config`, `lockfile`, `trigger`, `autoAcceptEffective`, `isTTY`) is referenced by ≥2 of the helpers and is computed exactly once in `runSync` (131–138). The struct earns its keep.
- **All v0.2.1 high-priority issues resolved**: `UserError`/`EnvError`/`CollisionError` now imported from `lib/errors.ts` (line 9) — no exit-code duplication. `formatShortSha` imported from `lib/term.ts` (line 16) — magic `.slice(0, 7)` constants gone (294, 295). `effectivePolicy`/`effectiveAutoAccept` now in `lib/policy.ts` (line 15). `formatCollisionMessage` is no longer duplicated against `cli.ts`'s variant (single home here at 470).
- **Apply-gate decision tree is unchanged and still well-documented.** `decideApply` (420–433) is a flat seven-line function with the same three precedence rules as v0.2.1, plus the explicit DI-vs-real-prompt branch (428–432) tested in sync.test.ts.
- **Lockfile is still written exactly once** at line 149, after the per-source loop. The skipped-source invariant (sources entry stays at priorSha) is preserved by `recordSkip` not touching `ctx.lockfile.sources`.
- **ISO timestamps for ack/log entries** (288, 305, 354) are consistent — no `Date.now()` mixed with strings.

## Concerns

### Cohesion
The module is single-purpose: orchestrate sync. The decomposition into per-phase helpers actually improves cohesion versus the v0.2.1 monolith. Minor: `formatCollisionMessage` (470–479) is presentation logic that could live next to `CollisionError`'s definition in `lib/errors.ts`, but it is genuinely sync-specific (the "Resolve by adding `preferredSources`…" hint at 475 is about `ccpp.config.json`), so keeping it here is defensible.

### Coupling
- Imports six `lib/*` modules (1–17), which is appropriate for an orchestrator. The new `lib/policy.ts` (15) and `lib/errors.ts` (9) imports replace the previous duplicated definitions — net reduction in coupling.
- `SyncContext` is private (not exported) — it's a deliberate seam between `runSync` and the per-phase helpers. Good encapsulation.
- The `Awaited<ReturnType<typeof cloneOrUpdate>>` inferred-type alias (229, 233, 262, 342) is leaky — it forces the helper signatures to spell out the return shape of an unrelated module's function. A small named type `SyncedSource` (or exporting the return shape from `lib/git.ts`) would be cleaner.
- `cloneOpts: Parameters<typeof cloneOrUpdate>[1]` (230) is the same anti-pattern. Same fix.

### Maintainability
- **`runSync` (111–162) is ~50 effective lines** — well within budget.
- **`syncOneSource` (180–219) is ~40 lines** — readable, but the "if applied/no-changes else recordSkip" dispatch at 206–218 could be a `switch` on `applyStatus` for symmetry with `decideApply`'s four-state union. Minor.
- **`applySource` (259–332) is 73 lines** — at the upper edge. The function is doing four distinct things: snapshot priorDests (271–273), call `applyManifest`, mutate `ctx.lockfile.sources`, derive `removed`, then format + log + return. The middle (lockfile update + removed-derivation) could split out as `recordApplyOutcome(ctx, source, synced, result)`. Not urgent.
- **The per-source-helper signatures are wide.** `applySource` takes 8 parameters (260–268), `recordSkip` takes 7 (340–347). Shared values (`priorSha`, `policy`, `synced`) are computed in `syncOneSource` and passed down rather than re-derived. That's the right tradeoff (avoid re-work) but a small `SourceState` struct grouping `{ source, synced, priorSha, policy }` would tighten the signatures.
- **`priorDests` derivation (271–273)** is still inline — the v0.2.1 review's medium suggestion to move this into `lib/lockfile.ts` as `destinationsForSource(lockfile, url): string[]` was not implemented. The query is duplicated against `cli.ts`'s uninstall path. Worth a follow-up.
- **`appendSyncLog` calls** — three call sites (303, 352, 382) each spell out the log entry shape. The v0.2.1 review suggested a `logSyncOutcome(outcome, ctx, source, extras)` helper; today only the error path has been factored (as `logSyncError`, 381). Success and skip still construct the entry inline. Modest duplication; the `now` timestamp + `trigger` + `sourceUrl` fields repeat at 304–307, 353–356, 383–386.
- **`changesetCounts` (394–404)** is a perfect helper — pure, three-lines-of-data, used in two places.
- The doc comment at 96–110 is excellent — it states the apply-gate precedence, the skipped-source pin invariant, and the "exit 0 from hooks" UX contract. Future readers won't have to reverse-engineer the policy.

### Style
- **Naming is clean.** `applyStatus`, `priorSha`, `synced`, `effectivePolicy`, `autoAcceptEffective` all read well. The v0.2.1 suggestion to rename `priorSha` → `previousSha` was not adopted, but `priorSha` is also fine and is consistent with the lockfile field names.
- **The `// DI hook for tests` block (44–55)** is a model of how to document an injectable seam. The `confirm` and `isTTY` fields are explicitly justified in the JSDoc.
- **`recordSkip`'s return value** (363–377) sets `sha: priorSha ?? synced.sha` (367). Still no comment explaining why the synced.sha is used for never-synced skips — the v0.2.1 review's low-priority note. A one-line comment would help.
- **`for (const source of config.sources)`** (143) is sequential. If two sources are independent, parallelism would speed up multi-source syncs — but the lockfile-mutation contract makes this intentionally sequential. Worth a one-liner: `// Sequential: each iteration mutates ctx.lockfile in place; parallelizing would race.`

## Specific issues
- **commands/sync.ts:271–273**: in-place lockfile query (`Object.entries(ctx.lockfile.installed).filter(...)`) — same pattern needed elsewhere; v0.2.1 medium suggestion to extract `destinationsForSource` into `lib/lockfile.ts` is still open.
- **commands/sync.ts:229, 262, 342**: `Awaited<ReturnType<typeof cloneOrUpdate>>` alias-by-inference. Brittle. Prefer a named export from `lib/git.ts` (e.g. `CloneResult`).
- **commands/sync.ts:303–315 vs 352–361 vs 382–391**: three `appendSyncLog` call sites with overlapping field shapes. Only the error-path branch has been factored (`logSyncError`); a `logSyncOutcome` helper covering all three would close this.
- **commands/sync.ts:259–268**: `applySource` accepts 8 positional parameters. Bundle `{ source, synced, priorSha, policy }` into a small `SourceState` struct.
- **commands/sync.ts:367**: `sha: priorSha ?? synced.sha` for skipped never-synced sources is correct but undocumented.
- **commands/sync.ts:248–250**: `for (const w of manifest.warnings) process.stderr.write(...)` — the warnings are written to stderr but never propagated into the `SyncReport`. JSON consumers see them in stderr only, which is awkward for programmatic clients. Mirror the pattern in `installer.ts`'s `ApplyManifestResult` and add a `warnings` field on `SourceSyncReport`.
- **commands/sync.ts:310–312**: spread-with-conditional-key (`...(result.conflicts.length > 0 && { error: ... })`) — same idiom flagged in v0.2.1; the rest of the repo uses the same pattern, so leave as-is or standardize project-wide.

## Suggestions
- **[medium]** Extract `destinationsForSource(lockfile, url): string[]` into `lib/lockfile.ts`; replace the inline derivation at 271–273 and the matching one in `cli.ts`'s uninstall path.
- **[medium]** Factor a `logSyncOutcome(ctx, source, outcome, extras)` helper and rewrite the three call sites (303, 352, 382). Closes the last bit of v0.2.1 duplication that survived the refactor.
- **[medium]** Replace `Awaited<ReturnType<typeof cloneOrUpdate>>` with a named `CloneResult` exported from `lib/git.ts`. Touches sync.ts and any future callers.
- **[medium]** Propagate `manifest.warnings` into `SourceSyncReport` so JSON consumers can see them (today they only hit stderr at 248–250).
- **[low]** Bundle the 8-parameter `applySource` call into a `SourceState` struct.
- **[low]** One-line comments on (a) the `for (const source of config.sources)` sequentiality at 143, (b) the `priorSha ?? synced.sha` fallback at 367.
- **[low]** Consider splitting `applySource` (259–332) into `runApply` (call applyManifest, derive removed) + `recordApplyOutcome` (mutate lockfile.sources, log, format).

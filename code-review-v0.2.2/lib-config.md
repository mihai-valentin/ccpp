# Module: src/lib/config.ts

**LoC**: 474  •  **Test file**: yes — `src/lib/config.test.ts` (363 LoC)  •  **v0.2.2 status**: refactored

## Purpose
Defines the `ccpp.config.json` schema (`CcppConfig`) and the v0.1.1 sync-policy / auto-accept feature flags. Implements the key/value DSL (`syncPolicy`, `autoAccept`, `sources.<url>.policy`, etc.) for `ccpp config get/set/list/reset`, and the first-enable acknowledgement gate that forces explicit user confirmation for risky modes (`syncPolicy:latest`, `autoAccept:true`).

## Public surface
- Const: `CONFIG_FILENAME`, `SYNC_POLICIES`, `CONFIG_DEFAULTS`, `POLICY_LATEST_WARNING`, `AUTO_ACCEPT_WARNING`
- Types: `SyncPolicy`, `ConfigSource`, `CcppConfig`, `ConfigEntry`, `AckKind`, `ApplyConfigSetOptions`
- Functions: `emptyConfig`, `configExists`, `readConfig`, `writeConfig`, `getConfigValue`, `setConfigValue`, `requiresAcknowledgement`, `applyConfigSet`, `resetConfigValue`, `listConfig`

## Strengths
- v0.2.1 finding ("non-atomic write") is **resolved**: `writeConfig` (line 84) uses `writeFileAtomic`.
- v0.2.1 finding ("stable-stringify duplicated with lockfile.ts") is **resolved**: imports `stableStringifyValue` from `./json-stable.js` (line 3).
- v0.2.1 finding ("ack timestamps not validated as ISO-8601") is **resolved**: `policyAcknowledgedAt` and `autoAcceptAcknowledgedAt` go through `isIsoTimestamp` (lines 162–177) with the same round-trip check used by lockfile.
- v0.2.1 finding ("three-site `if (!parsed) throw unknownKeyError(key)` boilerplate") is **resolved**: `parseKeyOrThrow` (lines 208–212) is the central helper, used at lines 245, 273, 396.
- The `ParsedKey` ADT (lines 194–199) keeps the key DSL declarative; the switch at line 246 / 274 / 397 is exhaustive and TS will flag a missing case.
- Defaults centralized in `CONFIG_DEFAULTS` (lines 34–37) — `getConfigValue` and `listConfig` apply them at read time, keeping a fresh on-disk config minimal.

## Concerns
### Cohesion
Still mixes four concerns flagged in v0.2.1: schema/persistence, validation, key DSL, acknowledgement orchestration. The file is 474 LoC — at the upper edge of "still one thing". Splitting along those seams (e.g. moving `applyConfigSet` to `commands/config.ts`) was a deferred suggestion in v0.2.1 and has not been taken; the current size is manageable but pre-extract would relieve maintenance pressure if a v2 schema arrives.

### Coupling
- Imports `node:fs`, `./fsutil.js`, `./json-stable.js`. Clean.
- The acknowledgement layer is still injected via `confirm` callback (line 335) — config.ts does not import `term.ts`. Right boundary preserved.

### Maintainability
- `validate` (lines 88–188) is 100 lines of straight-line schema checks — long but linear, each block reads "check field X, normalize, append". Acceptable.
- `isIsoTimestamp` (lines 5–10) is **duplicated byte-for-byte** with `lockfile.ts:136–142`. The v0.2.2 refactor extracted `json-stable.ts` but missed this twin. Worth one more pass to consolidate.
- v0.2.1 suggestion ("validate the raw value in `applyConfigSet` *before* prompting for acknowledgement") is **not addressed**: lines 355–379 still prompt first, then call `setConfigValue`, which can throw on an invalid value *after* the user has answered the risk prompt. The inputs that trigger this are narrow (`autoAccept` only accepts `true`/`false` strings; `syncPolicy` only accepts the two known labels) but the user-hostile ordering remains. Re-flag.
- `requiresAcknowledgement` does `rawValue.trim().toLowerCase() === 'latest'` (line 318) — same raw-string entry-point pattern as v0.2.1; comment-on-intent at line 308 acknowledges this is the CLI raw-input path.

### Style
- Naming consistent.
- Doc comments on every exported function are concrete (input, mutation, error conditions). Good model.
- Conditional re-attaching `if (… !== undefined) config.X = …` (lines 179–186, 358–379) is verbose but clear.
- No emojis, no TODOs, no dead code.

## Specific issues
- `src/lib/config.ts:5–10` — `isIsoTimestamp` is byte-identical with `lockfile.ts:136–142`. Extract.
- `src/lib/config.ts:355–379` — `applyConfigSet` still prompts for acknowledgement *before* calling `setConfigValue`, so an invalid value triggers the warning prompt and then errors out. v0.2.1 review's [high] suggestion was not adopted; user-hostile but harmless. Re-order is one local change.
- `src/lib/config.ts:333–338` — `ApplyConfigSetOptions.now` doc says "Defaults to `new Date().toISOString()`" — match the implementation phrasing on line 376 (`opts.now ?? (() => new Date().toISOString())`). Minor.

## Suggestions
- **[medium]** Extract the duplicated `isIsoTimestamp` helper (config.ts and lockfile.ts) into a shared module — `lib/iso.ts` or attach it to `lib/json-stable.ts`. The v0.2.2 refactor pulled the stringifier; this twin survived.
- **[medium]** Re-order `applyConfigSet` (lines 355–379) so `setConfigValue` (or at least value coercion) runs *before* the ack prompt. Today the user can answer "yes I want syncPolicy:latest" and then see "expected pinned, latest, got 'lateST'". Local fix.
- **[low]** Defer-but-consider: move `applyConfigSet` to `commands/config.ts` so `lib/config.ts` is pure data + validation. The `confirm` callback is UX flow.

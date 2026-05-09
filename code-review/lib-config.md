# Module: src/lib/config.ts

**LoC**: 482  •  **Test file**: yes — `src/lib/config.test.ts` (363 LoC)

## Purpose
Defines the `ccpp.config.json` schema (`CcppConfig`), the v0.1.1 sync-policy / auto-accept feature flags, and a small key/value DSL (`syncPolicy`, `autoAccept`, `sources.<url>.policy`, etc.) for `ccpp config get/set/list/reset`. Owns the first-enable acknowledgement gate that forces explicit user confirmation before unsafe modes (`syncPolicy:latest`, `autoAccept:true`) take effect.

## Public surface
- Const: `CONFIG_FILENAME`, `SYNC_POLICIES`, `CONFIG_DEFAULTS`, `POLICY_LATEST_WARNING`, `AUTO_ACCEPT_WARNING`
- Types: `SyncPolicy`, `ConfigSource`, `CcppConfig`, `ConfigEntry`, `AckKind`, `ApplyConfigSetOptions`
- Functions: `emptyConfig`, `configExists`, `readConfig`, `writeConfig`, `getConfigValue`, `setConfigValue`, `requiresAcknowledgement`, `applyConfigSet`, `resetConfigValue`, `listConfig`

## Strengths
- Defaults are explicit and centralized (`CONFIG_DEFAULTS`, lines 25-28) — the `getConfigValue` and `listConfig` paths apply them at read time rather than on disk, so a fresh config remains minimal.
- Acknowledgement gating (lines 288-359) is well-modeled: `requiresAcknowledgement` is a *pure* check, `applyConfigSet` orchestrates the prompt + write + timestamp. Easy to test.
- `AckKind` is a tagged enum (lines 37) — callers get a type-safe discriminator rather than a magic string.
- Per-key validation messages name the offending field and the path (e.g. line 100, 109, 120) — debuggable failures.
- The `ParsedKey` ADT (lines 177-182) keeps the key DSL declarative and exhaustive — the switch at lines 224-242 / 253-280 is exhaustively typed and the TS compiler will flag a missing case if a new variant is added.

## Concerns
### Cohesion
This module mixes four concerns:
1. Schema + persistence (lines 1-77, 456-482) — the JSON IO layer
2. Validation (lines 79-175) — schema enforcement
3. Key DSL + read/write (lines 177-281) — the `get`/`set` semantics
4. Acknowledgement orchestration (lines 283-359) — UX flow control

#1 + #2 belong together. #3 is a separate concern (it depends on the data model but is its own layer). #4 is application-layer flow — arguably belongs in `commands/config.ts`, not the lib. At 482 LoC, the file is on the upper edge of "still one thing"; splitting along these seams would help.

### Coupling
- Stdlib only — clean.
- Re-implements stable-JSON stringify (lines 456-482) — duplicated from `lockfile.ts:49-79` with cosmetic differences. See lockfile review.
- The acknowledgement layer is *injected* via the `confirm` callback (line 314), so config.ts doesn't depend on `term.ts` — good. The downside is the call site in `commands/config.ts` needs to wire the prompt — but that's the right boundary.

### Maintainability
- `validate` (lines 79-171) is 92 lines of straight-line validation — long but linear. Each block reads "check field X, normalize, append". Could be table-driven (an array of `{ key, kind: 'string' | 'enum' | 'object' | 'array', required, ... }`) but the present hand-written form is more diff-friendly when fields evolve. Acceptable.
- **No atomic write**: `writeConfig` uses plain `fs.writeFile` (lines 75-77). Same risk as `lockfile.ts:42`.
- **`policyAcknowledgedAt` / `autoAcceptAcknowledgedAt` strings are not validated as ISO-8601** (lines 153-160). The validator only checks `typeof === 'string'`. A user editing the config to `policyAcknowledgedAt: "yes"` passes validation. The values are used purely as `!== undefined` markers (line 298), so the laxness is harmless today, but documentation should say so or the validator should tighten.
- `requiresAcknowledgement` (lines 288-310) does `rawValue.trim().toLowerCase() === 'latest'` — a string comparison. If a future caller passes a *typed* `SyncPolicy` value, the function can't be reused. Today it's only called from CLI input which is always raw string. Mark it explicitly as the "raw-string entry point".
- `setConfigValue` mutates `config` in place (line 246-247 docstring acknowledges this). That's fine, but `applyConfigSet` (line 354-358) writes the ack timestamp *after* `setConfigValue` succeeded — which means a thrown `setConfigValue` (e.g. invalid raw value) leaves the ack un-written. Order is correct, but a comment at line 352 would help future readers see the invariant.
- The two big stable-stringify functions (lines 53-79 and lines 456-482) drift over time: today they're nearly identical, but they will diverge silently. Fix is to extract.

### Style
- Naming consistent. `parseKey` returns `ParsedKey | null`; the `null` branch is then mapped to `unknownKeyError` at every caller (lines 222-223, 251-252, 376). A small helper `parseKeyOrThrow(key): ParsedKey` would remove that boilerplate.
- Some methods are conditionally re-attaching fields to objects (`if (... !== undefined) config.X = ...`) at lines 162-169 and 354-358 — pattern is consistent but verbose. Could be `Object.assign(config, { ... })` but the explicit form is clearer. Acceptable.
- The warning strings (lines 39-43) are long single-line string literals; on narrower terminals they'll wrap. Probably fine for risk-warning text where re-flow is OK.
- No emojis, no TODOs, no dead code.

## Specific issues
- `src/lib/config.ts:75-77` — non-atomic write. Same write-temp-then-rename fix as lockfile.ts.
- `src/lib/config.ts:153-160` — ack-timestamp fields are accepted as any string. If desired as ISO-8601, validate with `Number.isFinite(Date.parse(v))`. If not desired, document that.
- `src/lib/config.ts:456-482` — stableStringify is duplicated from `lockfile.ts:49-79`. Extract to a shared `json-stable.ts`.
- `src/lib/config.ts:222-223, 251-252, 376` — three sites do `if (!parsed) throw unknownKeyError(key)`. Extract `parseKeyOrThrow`.
- `src/lib/config.ts:140` — `for (const [k, v] of Object.entries(...))` rebuilds `map` even when no validation transformation happens. Could just `normalisedPreferred = preferredSources as Record<string, string>` after type-checking. Minor; current form makes "we deliberately copied" explicit.
- `src/lib/config.ts:328-359` — `applyConfigSet` is `async` but `setConfigValue` is synchronous. The mixed sync/async is a minor cognitive load. Document why (it's because `confirm` may be async).
- `src/lib/config.ts:407-438` — `listConfig` always emits a row for every configured source's policy, even when there are zero sources. That's correct UX but rendering "(no sources configured)" might be clearer than an empty section in `commands/config.ts`. Out-of-scope here, just noting.
- `src/lib/config.ts:255` — `config.syncPolicy = coerceSyncPolicy(key, rawValue)` is called by `applyConfigSet` *after* the ack prompt. If the user agrees to switch to `latest` and the value is invalid, the prompt has already happened — they were asked about something we then reject. Order is harmless but slightly user-hostile.

## Suggestions
- **[high]** Atomic write for `writeConfig` (extract a shared `writeJsonAtomic` into `fsutil.ts`).
- **[high]** Validate the raw value in `applyConfigSet` *before* prompting for acknowledgement (so an invalid `--value foobar` doesn't make the user re-confirm a risk). Re-order: `coerceSyncPolicy(key, rawValue)` → check `requiresAcknowledgement` against the *coerced* value → prompt → write.
- **[medium]** Extract the stable-JSON stringifier into `src/lib/json-stable.ts` and import in both `config.ts` and `lockfile.ts`.
- **[medium]** Add a `parseKeyOrThrow` helper to remove the three-site `if (!parsed) throw unknownKeyError(key)` boilerplate.
- **[medium]** Tighten the ack-timestamp string validation to require ISO-8601 (a one-liner with `Date.parse`).
- **[low]** Consider moving `applyConfigSet` to `commands/config.ts` since it's UX flow (prompts, time provider) — leaves `config.ts` as a pure data/validation module. Defer if it would churn callers.
- **[low]** Comment at line 352 documenting the "ack timestamp written after successful set" invariant.

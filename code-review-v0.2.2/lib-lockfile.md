# Module: src/lib/lockfile.ts

**LoC**: 142  •  **Test file**: yes — `src/lib/lockfile.test.ts` (202 LoC)  •  **v0.2.2 status**: refactored

## Purpose
Reads, validates, writes `ccpp.lock.json`. Owns the schema-version gate (`version: 1` only), per-entry validation of `sources` and `installed`, and a deterministic on-disk format (sorted keys, 2-space indent, trailing newline) so lockfile diffs in git stay clean.

## Public surface
- Const: `LOCKFILE_FILENAME`
- Functions: `emptyLockfile`, `readLockfile`, `writeLockfile`, `stableStringify`

## Strengths
- v0.2.1 finding ("non-atomic write — SIGINT mid-write leaves a torn lockfile") is **resolved**: `writeLockfile` (line 45) delegates to `writeFileAtomic`. Doc at lines 38–45 names the behaviour explicitly.
- v0.2.1 finding ("`stableStringifyValue` duplicated with config.ts") is **resolved**: imported from `./json-stable.js` (line 3). Single canonical implementation.
- v0.2.1 finding ("per-entry shapes not validated — hand-edited typos manifest downstream") is **resolved**: `validateSourceEntry` (lines 88–101) and `validateInstalledEntry` (lines 103–122) check every field, with key paths in error messages (e.g. `sources["${url}"].sha`, line 93).
- v0.2.1 finding ("ack-timestamp / lastSync strings not validated as ISO-8601") is **resolved for lockfile**: `requireIsoTimestamp` (lines 130–134) gates `lastSync` and `installedAt` with a Date round-trip check.
- ENOENT → `emptyLockfile()` (lines 24–26) preserved — first-run ergonomics intact.

## Concerns
### Cohesion
Tight: read / write / validate / serialize for one file format. The version-gate, per-entry validators, and stringifier are all coherently in scope.

### Coupling
- Imports `node:fs`, `./fsutil.js`, `./json-stable.js`, `./types.js`. Exactly the right surface.
- `LockSourceEntry` / `LockInstalledEntry` come from `types.ts`; the validators here are the producer of those typed values. Clean.

### Maintainability
- 142 LoC, no function over 40 lines. Linear straight-line validation that's easy to amend when a field is added.
- `requireString` (lines 124–128) and `requireIsoTimestamp` (lines 130–134) are tiny private helpers — exactly the right level of abstraction.
- The ISO-8601 check (line 141) compares `new Date(parsed).toISOString().slice(0, 10)` against `s.slice(0, 10)`. This rejects loose strings like `"2026"` or `"today"` — correct — but accepts any input where the YYYY-MM-DD prefix matches and the rest parses (e.g. `"2026-04-15garbage"` would parse if `Date.parse` is lenient). For lockfiles ccpp itself writes, this is fine; for hand-edits, it's a soft validation. Same pattern is duplicated in `config.ts:5–10`. Worth extracting.

### Style
- Error messages consistently include the path and the offending field key — debuggable.
- Doc comments on every exported function explain the intent without restating the body.
- No emojis, no TODOs, no dead code.
- `stableStringify` (line 52) is a thin wrapper around `stableStringifyValue` that appends `\n` — could be inlined into `writeLockfile`, but exposing it for tests is reasonable.

## Specific issues
- `src/lib/lockfile.ts:136–142` — `isIsoTimestamp` is byte-identical to `config.ts:5–10`. With `json-stable.ts` already extracted, an `iso-timestamp.ts` (or simply moving this helper to `fsutil.ts` / a new `validators.ts`) would close the last duplication. Low priority.
- `src/lib/lockfile.ts:141` — round-trip check only compares the YYYY-MM-DD prefix. Strings like `"2026-04-15foo"` slip through if Date.parse coerces them (Node's parser is lenient on suffix garbage). Acceptable for ccpp-written values; minor for hand-edits.
- `src/lib/lockfile.ts:62–65` — version-mismatch error still implies no migration path. Same tech-debt note as v0.2.1; not introduced here.

## Suggestions
- **[low]** Extract `isIsoTimestamp` once more into a shared validator module (or `json-stable.ts`) so config.ts doesn't keep its own copy. The duplication is now small but it survived this refactor.
- **[low]** Tighten the ISO check to use the strict regex `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/` if you want to reject `"2026-04-15garbage"`. Current behaviour is acceptable.
- **[low]** Plan a forward-compat strategy for `version: 2` (stub `migrate(raw)` function) so the eventual schema bump doesn't strand existing users.

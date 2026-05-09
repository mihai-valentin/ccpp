# Module: src/lib/lockfile.ts

**LoC**: 104  •  **Test file**: yes — `src/lib/lockfile.test.ts` (135 LoC)

## Purpose
Reads, validates, and writes `ccpp.lock.json`. Owns the schema-version gate (only `version: 1` accepted), the deterministic stringifier (sorted keys, 2-space indent, trailing newline) so lockfile diffs in git stay clean, and the empty-lockfile factory. Treats a missing file as an empty lockfile — making first-time use of ccpp ergonomic.

## Public surface
- Const: `LOCKFILE_FILENAME`
- Functions: `emptyLockfile`, `readLockfile`, `writeLockfile`, `stableStringify`

## Strengths
- ENOENT → `emptyLockfile()` (lines 22-24) is the right behaviour for a CLI that bootstraps state on first run.
- Parse failures and version mismatches throw with the offending path included (lines 25, 31, 87-89) — easy to diagnose in the wild.
- Deterministic serialization (`stableStringifyValue`, lines 53-79) recurses without needing a third-party canonicalizer; trailing newline at line 50 means POSIX tools play nicely.
- Trade-off correctly chosen: the validator is structural (object shape, version literal) but does NOT introspect each `installed[destPath]` or `sources[url]` value (lines 99-103). For a v0.1.x lockfile this is acceptable — the data is written by ccpp itself, so it's typically self-consistent — but the `as Lockfile['installed']` cast carries a soft assumption (see Specific issues).

## Concerns
### Cohesion
Tight: all four functions are about reading/writing/validating the same file. The stringifier could plausibly move to a shared `json-stable.ts` since `config.ts:456-482` re-implements it (see Specific issues).

### Coupling
- Imports stdlib `fs` and the `Lockfile` type — minimal.
- Used by `installer.ts`, `diff.ts`, `cli.ts`, `commands/sync.ts`, `commands/status.ts` (per repo grep).
- Uses `as Lockfile['sources']` / `as Lockfile['installed']` (lines 101-102) — a structural type-cast with no further validation. If a malicious or corrupted lockfile has, say, `installed[someKey] = "not an object"`, downstream callers see broken data and crash later in inconvenient places (`entry.sourceUrl` would be `undefined` at `diff.ts:47`). For v0.1 this is acceptable; for future hardening, validate each entry shape.

### Maintainability
- 100 LoC, no functions > 25 lines, easy to read.
- **No atomic write**: `writeLockfile` (lines 41-43) uses plain `fs.writeFile` — a crash mid-write leaves a truncated lockfile, which subsequent `readLockfile` will reject with a JSON parse error. The CLI then refuses to run. Industry-standard fix: write to `${path}.tmp`, fsync, then `fs.rename` to the final path. Same applies to `config.ts:75-77`.
- **No file locking**: two concurrent `ccpp sync` invocations would race. Probably out of scope (single-user CLI), but worth a note in the docs.
- The stable-stringify for a Lockfile is duplicated in `config.ts:456-482` (with subtle differences — config.ts has `null` literal handling earlier, lockfile.ts has it at line 54). Consolidate to a shared helper.

### Style
- `stableStringifyValue` (line 53) returns string; `stableStringify` (line 49) just appends `\n`. The naming difference (Value suffix) is fine but the comment at lines 76-78 about "shouldn't happen with Lockfile values" suggests the function was written generically and *could* be shared with config.ts.
- `validateLockfile` (lines 81-104) is straight-line; readable. Consistent error messages (`Invalid lockfile ${path}: ...`).
- No emojis, no TODOs, no dead code.

## Specific issues
- `src/lib/lockfile.ts:42` — non-atomic write. A SIGINT / EIO during write produces a half-written JSON file. Use `writeFile(${path}.tmp)` + `rename(${path}.tmp, path)`.
- `src/lib/lockfile.ts:101-102` — `obj.sources as Lockfile['sources']` and `obj.installed as Lockfile['installed']` skip per-entry validation. If a user hand-edits the file and types `installed: { foo: "bar" }`, the validator passes. The structural failure manifests downstream. Add a per-key shape check (`installed[k]` must be object with `sourceUrl: string`, `sourcePath: string`, `sourceSha: string`, `installedAt: string`).
- `src/lib/lockfile.ts:53-79` — duplicated by `config.ts:456-482` with cosmetic differences. Extract to `src/lib/json-stable.ts`.
- `src/lib/lockfile.ts:86-90` — version mismatch error suggests no migration path exists. When/if v2 ships, the user will have to manually delete the lockfile. Not a present bug; just a tech-debt marker.
- `src/lib/lockfile.ts:50` — `\n` is appended to the *value*, not via `os.EOL`. Intentional and correct (we want POSIX line endings in repo-checked-in JSON), but worth documenting.
- `src/lib/lockfile.ts:78` — comment says "shouldn't happen with Lockfile values" but the function takes `unknown` and is generic. If extracted to a shared module, that comment is misleading.

## Suggestions
- **[high]** Make `writeLockfile` atomic: write-temp + rename. The same fix applies to `writeConfig`. A single `writeJsonAtomic(path, content)` helper in `fsutil.ts` solves both.
- **[medium]** Extract `stableStringifyValue` into `src/lib/json-stable.ts`; have both `lockfile.ts` and `config.ts` import it. Drop the duplication.
- **[medium]** Tighten `validateLockfile` to validate per-entry shape (each `LockSourceEntry` and `LockInstalledEntry`). The cost is ~30 lines of code; the benefit is users get a clear error for hand-edited typos rather than a downstream crash.
- **[low]** Document the trailing-newline + POSIX-EOL choice with a one-liner comment at line 50.
- **[low]** Plan a forward-compat strategy for `version: 2` (even just a stub `migrate(raw)` function) so the eventual schema bump doesn't strand existing users.

# Module: src/lib/log.ts

**LoC**: 95  •  **Test file**: yes — `src/lib/log.test.ts` (107 LoC)  •  **v0.2.2 status**: refactored (small comments added)

## Purpose
NDJSON sync-event log written to `${CCPP_HOME:-~/.ccpp}/sync.log`. Records every `ccpp sync` invocation (manual or hook-triggered) with a coarse outcome and changeset summary. Self-rotates at ~1 MB; never crashes the caller (logging is best-effort).

## Public surface
- Types: `SyncTrigger`, `SyncOutcome`, `SyncLogEntry`
- Functions: `defaultLogPath`, `appendSyncLog`, `readSyncLog`

## Strengths
- v0.2.1 [medium] suggestion ("comment the non-atomic rotation as intentional") is **resolved**: lines 90–93 document the trade-off explicitly ("Non-atomic on purpose — sync.log is best-effort logging, not lockfile state. A SIGINT mid-rotate truncates the file, which is acceptable…"). This is exactly the rationale the v0.2.1 reviewer asked for.
- v0.2.1 [medium] suggestion ("comment asymmetric error handling vs `readSyncLog`") is **partially addressed**: line 51 has a comment ("Logging is best-effort; never propagate failure into sync or hook paths.") explaining the swallow. The asymmetry with `readSyncLog`'s throwing behaviour is implicit; an explicit cross-reference would make it obvious.
- NDJSON, append-only, line-resumable, jq-friendly — right format choice.
- Best-effort discipline (try/catch wraps all writes at line 45) means logging cannot break sync.
- Auto-rotation keeps disk bounded without user intervention.
- Malformed-line tolerance (lines 73–78) survives a partial-line crash mid-write.

## Concerns
### Cohesion
Single-purpose: NDJSON sync log. Append, read, rotate, defaults — all of one piece.

### Coupling
- Stdlib only.
- Used by `commands/sync.ts` (write) and `commands/status.ts` (read). Tight, expected.
- `SyncLogEntry` shape is constructed at the call sites by literal — drift risk noted in v0.2.1 still applies; no `makeEntry` builder added.

### Maintainability
- 95 LoC, 3 exported functions, 1 private (`rotate`). Readable end-to-end.
- v0.2.1 finding ("rotation race between concurrent appenders") is **not addressed**. Two ccpp processes appending and triggering rotation can race — second rotate's overwrite wipes the first's appended-since-stat tail. For single-user CLI + occasional hook, unlikely; remains a documented assumption.
- v0.2.1 finding ("`TRIM_TO_ENTRIES` is count-based, not size-based — pathologically large entries could keep file > MAX_BYTES after rotation") is **not addressed**. With 4–6 small fields per entry, this is unlikely to bite; defer.
- v0.2.1 finding ("`JSON.parse(line) as SyncLogEntry` casts without runtime validation") is **not addressed**. Low priority — log is consumed only by `ccpp status` for human display.
- The `rotate` function (lines 86–95) reads through `readSyncLog` (line 87), so it inherits malformed-line tolerance — subtle but right.

### Style
- Doc comments on every exported function name the trigger / outcome / data invariants.
- The `MAX_BYTES = 1_000_000` and `TRIM_TO_ENTRIES = 500` literals (lines 33–34) are unexported but well-named. Acceptable.
- No emojis, no TODOs, no dead code.

## Specific issues
- `src/lib/log.ts:48–50` — rotation race remains. Single-user CLI assumption holds; hook + manual-sync interleave is the only realistic trigger and is unlikely.
- `src/lib/log.ts:33–34, 88` — entry-count trim, not size-bound trim. Pathological case (very long error strings) could cause rotate-on-every-append loop. Unlikely.
- `src/lib/log.ts:75` — `JSON.parse(line) as SyncLogEntry` accepts any JSON shape. A line like `{"foo":1}` becomes a typed-as-`SyncLogEntry` value with undefined fields. `ccpp status` renders these as blanks. Low priority.
- `src/lib/log.ts:51` — comment names the swallow but doesn't explicitly cross-reference `readSyncLog`'s throw-on-error behaviour. Minor.

## Suggestions
- **[low]** Extend the line 51 comment to "asymmetric with readSyncLog by design — read failures should surface; write failures must not break sync."
- **[low]** Replace count-based trim with size-based: drop oldest entries until `bytes < MAX_BYTES * 0.5`. One short while-loop.
- **[low]** Consider a `makeEntry({ trigger, outcome, ... })` builder to reduce drift between sync.ts and tests.
- **[low]** No-op for v0.2.2: the rotation race is a real-but-unlikely concern. If it ever bites, advisory `flock` via `fs.open` + `flock` is the standard fix on Linux/macOS.

# Module: src/lib/log.ts

**LoC**: 91  •  **Test file**: yes — `src/lib/log.test.ts` (107 LoC)

## Purpose
NDJSON sync-event log, written to `${CCPP_HOME:-~/.ccpp}/sync.log`. Records every `ccpp sync` invocation (manual or hook-triggered) with a coarse outcome and changeset summary; supports tail reads for `ccpp status`. Self-rotates at ~1 MB to prevent unbounded growth, and swallows all write errors so logging never breaks the sync path.

## Public surface
- Types: `SyncTrigger`, `SyncOutcome`, `SyncLogEntry`
- Functions: `defaultLogPath`, `appendSyncLog`, `readSyncLog`

## Strengths
- NDJSON is the right format choice — append-only, line-resumable, trivially tailable with stdlib tools.
- Best-effort logging discipline (line 51-53): logging never crashes the caller. Sync should not fail because the log file is on a read-only filesystem.
- Auto-rotation (lines 49-50, 86-91) keeps disk usage bounded without user intervention.
- Malformed-line tolerance (lines 73-78): a partial line from a crash mid-write doesn't destroy the readability of the rest of the log.
- `defaultLogPath` is a function not a const (line 27-31, with explicit comment) — preserves test override paths via `CCPP_HOME`.
- Schema is small and stable: 4 required fields, 2 optional. Easy for humans to grep with jq.

## Concerns
### Cohesion
Single-purpose module: NDJSON sync log. Rotation, defaults, append, read — all tightly related.

### Coupling
- Imports stdlib only.
- Used by `commands/sync.ts:12` (write) and `commands/status.ts:9` (read). Tight, expected coupling.
- The `SyncLogEntry` shape is duplicated in spirit at the call sites — `commands/sync.ts` constructs entries by literal — so adding a field in one place means updating the other. A small `makeEntry` builder would reduce drift, but it's 4 fields, not urgent.

### Maintainability
- 91 LoC, 3 exported functions, single rotation private function. Easy to read end-to-end.
- **Rotation race**: `appendSyncLog` does append → stat → rotate (lines 48-50). `rotate` then reads the *whole* file, slices, and overwrites (lines 86-91). If two ccpp processes rotate concurrently, the second overwrite wipes the first's appended-since-stat tail. For a single-user CLI this is unlikely; for hook + manual sync interleaving it's possible. Mitigation: use `fs.open` with `O_APPEND` and writev, or skip rotation entirely under a "log too big — please rotate manually" warning.
- **Rotation isn't atomic**: `fs.writeFile(logPath, content)` (line 90) — a crash mid-write truncates the log. The "best-effort" promise covers this; you accept it. Worth one inline comment.
- `MAX_BYTES = 1_000_000` (line 33) and `TRIM_TO_ENTRIES = 500` (line 34) are tuned together (~2KB/entry expected). If entries grow larger (e.g. very long error strings), 500 entries could exceed 1MB and rotation would happen *every* append. Test at lines 76-98 sets up the boundary case but the runtime invariant (`TRIM_TO_ENTRIES * avg_entry_size < MAX_BYTES`) isn't asserted anywhere. A `safety: trim until size < MAX_BYTES` loop would be more robust than a fixed entry count.
- No structured logging consistency with the rest of the codebase: this is the *only* place ccpp produces structured (NDJSON) output. The CLI-side text output goes through `term.ts` color helpers. They serve different audiences (machine vs human) so the duality is fine, but it does mean an error in `commands/sync.ts` is logged to the sync log as `outcome: 'error', error: <message>` while *also* being printed to the user via `red(...)` — two paths to keep consistent.
- `appendSyncLog` always swallows errors (line 51-53), but `readSyncLog` *throws* on non-ENOENT errors (lines 67-70). The asymmetry is intentional (read failures should surface; write failures shouldn't break sync) but it's worth one comment near line 51 saying "asymmetric with readSyncLog by design".

### Style
- Naming consistent. `entries` / `lines` / `text` / `keep` — locally clear.
- The constants at lines 33-34 are private — fine. They could be exported for tests but the test file doesn't need them (it manufactures size with padding).
- `rotate` reads with `readSyncLog(undefined, logPath)` (line 87) — uses the public reader, which means rotation correctly skips malformed lines. Subtle but right.
- No emojis, no TODOs, no dead code.

## Specific issues
- `src/lib/log.ts:90` — non-atomic rotation overwrite. A SIGINT during rotation truncates the log. Since logging is best-effort this is consciously accepted; consider a one-line comment near line 90 to that effect.
- `src/lib/log.ts:48-50` — rotation race between concurrent appenders. Single-process CLI mostly avoids this; hooks + manual sync can collide. Document the assumption or add a `flock`-style guard (advisory file lock via `fs.open` + `flock` on Linux/macOS — Windows lacks an equivalent).
- `src/lib/log.ts:33-34, 88` — `TRIM_TO_ENTRIES` is a count, not a size; pathologically large entries could keep the file over `MAX_BYTES` after rotation. Replace the entry-count cap with a "trim oldest until under N bytes" loop.
- `src/lib/log.ts:73-78` — malformed-line tolerance silently drops content. Good for robustness, but a counter (e.g. metric or stderr warning when `>0` lines were dropped) would help diagnose corruption. Optional.
- `src/lib/log.ts:75` — `JSON.parse(line) as SyncLogEntry` casts without runtime validation. A line with valid JSON but wrong shape (`{ foo: 1 }`) is accepted and downstream `entry.outcome` is undefined. Parallel concern to lockfile.ts's per-entry validation. Low priority — this log is consumed only by `ccpp status` which renders human text, not by code that branches on the values.
- `src/lib/log.ts:71` — `text.split('\n').filter(l => l.length > 0)` — works, but on a 1MB file this allocates a big array. For 500 entries it's fine; if entry counts grow, a streaming line reader would be more memory-efficient. Defer until there's evidence.

## Suggestions
- **[medium]** Replace `TRIM_TO_ENTRIES = 500` with a size-based trim: drop oldest entries until total bytes < `MAX_BYTES * 0.5` (or similar). Makes rotation invariant size-bounded regardless of entry size.
- **[medium]** Add a one-line comment at line 51 explaining the asymmetric error handling vs `readSyncLog`.
- **[medium]** Add a one-line comment at line 90 acknowledging the non-atomic rotation as intentional under "best-effort".
- **[low]** Consider a `makeEntry({ trigger, outcome, ... })` builder to reduce drift between the call sites in `commands/sync.ts` and `commands/status.test.ts`.
- **[low]** Optionally validate parsed entries at runtime in `readSyncLog` (skip if shape doesn't match), or at least narrow with a `isSyncLogEntry` type-guard.
- **[low]** Document the single-process assumption (or add advisory `flock` if multi-process invocation is plausible).

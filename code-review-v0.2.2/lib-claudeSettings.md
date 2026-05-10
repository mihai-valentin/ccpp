# Module: src/lib/claudeSettings.ts

**LoC**: 49  •  **Test file**: no  •  **v0.2.2 status**: NEW in v0.2.2

## Purpose
Reads, writes, and identifies ccpp-owned hook blocks in `~/.claude/settings.json`. Defines the `ClaudeSettings` / `SessionStartBlock` / `HookCommand` shapes that `commands/install-hook.ts` and `commands/uninstall-hook.ts` consume.

## Public surface
- Types: `HookCommand`, `SessionStartBlock`, `ClaudeSettings`
- Functions: `readSettings`, `writeSettings`, `isCcppBlock`

## Strengths
- Tiny, focused module (49 LoC) covering exactly one external file format.
- `readSettings` distinguishes ENOENT from other errors (lines 31–34): missing file returns `null` (callers decide), other errors throw with a descriptive message. Matches the read pattern of `lockfile.ts` and `config.ts`.
- `writeSettings` uses `writeFileAtomic` (line 43) — consistent with the rest of the codebase. Doc names the failure mode the atomicity prevents: "Claude Code reads this file on every session start, so a torn write would break every subsequent session" (lines 38–41). That rationale is exactly the right thing to anchor a review against.
- `isCcppBlock` (lines 47–49) uses `\bccpp\b` word-boundary regex to decide ownership, which avoids false-positive on commands that merely contain the substring `ccpp` (e.g. `myccpp-tool`). Conservative — won't accidentally clobber a user's hook.
- `JSON.stringify(settings, null, 2)` (line 43) — 2-space indent, trailing newline (added in the template literal). No deterministic key sort, but Claude Code doesn't need it; settings.json is hand-maintained by users in many cases.

## Concerns
### Cohesion
Right-sized: types + read + write + classifier, all about the same file. No mixed concerns.

### Coupling
- Imports `node:fs` and `./fsutil.js`. Minimal.
- Consumers: `commands/install-hook.ts` (imports `readSettings`, `writeSettings`, `isCcppBlock`, plus the `ClaudeSettings` type) and `commands/uninstall-hook.ts` (same). Tight, expected.

### Maintainability
- 49 LoC, three functions, three types. Trivial.
- **No validation in `readSettings`.** The function does `JSON.parse(text) as ClaudeSettings` (line 30) with no shape check. A malformed `settings.json` (e.g. `hooks: "string"`) parses but downstream `settings.hooks?.SessionStart?.[0]` would be `undefined` or worse. For a user-edited file this is a meaningful gap — the user gets a downstream `TypeError` instead of a clear "your settings.json is malformed" message. Compare with `lockfile.ts`'s per-entry validation; this module's hand-off is significantly less defensive.
- `isCcppBlock` (line 48) regex check: `block.hooks.some((h) => h.type === 'command' && /\bccpp\b/.test(h.command))`. If a future ccpp release runs the hook via `bash -c "..."` or any command that doesn't contain a literal `ccpp` token, this classifier returns false and we treat our own block as user-owned. Today the install-hook only writes `ccpp …` commands, so it's safe; just a forward-compat note.
- **No test file.** This module mediates a user-facing config file (`~/.claude/settings.json`) and powers two commands; a smoke test (round-trip read+write, ENOENT → null, isCcppBlock true/false matrix) would be ~40 LoC.

### Style
- Doc comments on every export, each naming the rationale or contract.
- Type definitions allow extra fields via index signature (`[k: string]: unknown` at lines 16, 18) — sensible since Claude Code may add fields ccpp doesn't know about.
- No emojis, no TODOs.

## Specific issues
- `src/lib/claudeSettings.ts:30` — `JSON.parse(text) as ClaudeSettings` casts without shape validation. A malformed user-edited file produces a downstream crash rather than a clean error. Add a `validateSettings(raw)` that at minimum checks `hooks?` is an object and `hooks.SessionStart?` is an array. Or document explicitly that settings.json is trusted input.
- `src/lib/claudeSettings.ts:48` — `isCcppBlock` matches on the literal token `ccpp`. Robust today, but if the install-hook ever shells out via a wrapper, the classifier silently misses ccpp-owned blocks. Consider tagging blocks with a structural marker (`{ matcher: 'ccpp' }` or a sentinel field) so the identity isn't string-pattern-dependent.
- `src/lib/claudeSettings.ts` — no `claudeSettings.test.ts`. Round-trip read/write + `isCcppBlock` true/false matrix would be a quick win.
- `src/lib/claudeSettings.ts:42–44` — `writeSettings` does NOT use `stableStringifyValue`. Settings.json is hand-edited; preserving user key order is friendlier than re-sorting. Current behaviour is correct; worth one comment line stating that the asymmetry with config/lockfile is intentional.

## Suggestions
- **[medium]** Add a structural marker to ccpp-installed hook blocks (e.g. `matcher: '__ccpp_hook__'` or a custom field) so `isCcppBlock` can match by identity, not by command-string regex. The string match is robust today but coupled to implementation details of `install-hook.ts`.
- **[medium]** Add `claudeSettings.test.ts` — round-trip and `isCcppBlock` matrix.
- **[low]** Add at least minimal shape validation in `readSettings` so a malformed user-edited file produces a clean ccpp error rather than a downstream `TypeError`.
- **[low]** One-line comment near `writeSettings` explaining why the on-disk shape is *not* stable-stringified (preserves user key order in a hand-maintained file).

# Module: src/lib/term.ts

**LoC**: 171  •  **Test file**: yes — `src/lib/term.test.ts` (50 LoC, covers `stripColor` and `formatTable` only)  •  **v0.2.2 status**: refactored

## Purpose
Centralizes terminal-side concerns: ANSI color helpers (`green`, `yellow`, `red`, `dim`, `bold`), color enable/disable plumbing, the three interactive prompts (`promptYesNo`, `promptLine`, `promptChoice`), TTY-detection (`isInteractive`), short-SHA formatting, color stripping, and the column-aligned `formatTable` renderer used by `ccpp list` / `ccpp config list`.

## Public surface
- Const: `SHORT_SHA_LEN`
- Functions: `green`, `yellow`, `red`, `dim`, `bold`, `disableColor`, `formatShortSha`, `stripColor`, `isInteractive`, `formatTable`, `promptYesNo`, `promptLine`, `promptChoice`

## Strengths
- v0.2.1 finding ("no companion test file") is **partially resolved**: `term.test.ts` now exists (50 LoC) covering `stripColor` and `formatTable`. The prompt helpers (`promptYesNo`, `promptLine`, `promptChoice`) are still untested — same gap as v0.2.1.
- v0.2.1 finding ("magic `maxAttempts = 3`") is **resolved**: `MAX_PROMPT_ATTEMPTS` named constant at line 139 with a doc explaining the rationale ("three is enough to recover from a typo without livelocking on a non-interactive stdin stuck on EOF").
- v0.2.1 finding ("SGR codes are unexplained magic") is **resolved**: comment block at lines 22–23 names the codes (30-37 = foreground, 39 = default, 1 = bold, 2 = dim, 22 = normal-intensity).
- v0.2.1 suggestion (named constants for short SHA) is **adopted**: `SHORT_SHA_LEN = 7` (line 39) plus `formatShortSha` helper (line 42) — every place that abbreviates a SHA goes through it.
- New `isInteractive` (lines 57–59) centralizes the "stdin AND stderr both TTY" rule that the install-wizard / sync prompts depend on. v0.2.1 review noted this was scattered; now single-source.
- `formatTable` (lines 66–78) uses `stripColor` for width math, so colored cells line up correctly. Test at `term.test.ts:24` pins this.

## Concerns
### Cohesion
The module now does five things: SGR styling, color stripping, short-SHA formatting, table rendering, and prompts. They're all "stuff the CLI does to talk to a terminal", but `formatShortSha` is a domain helper (it knows about commit SHAs) that doesn't share state with the others — it's plausible to live in `git.ts` next to where SHAs originate. Defer; current grouping is "things commands import from one place" which is also a coherent rule.

### Coupling
- Imports `node:readline` only.
- Implicit coupling to `process.env`, `process.stderr`, `process.stdout.isTTY`, `process.stdin` — same as v0.2.1, no DI seam. The testing gap on prompts traces to this.

### Maintainability
- `colorEnabled` (lines 6–10) re-evaluates on every wrap call (intentional, for test seams). v0.2.1 nit ("doc the re-evaluation") is **resolved** — comment at lines 13–17 explains why.
- `promptYesNo` (lines 85–102) and `promptLine` (lines 110–132) still build the same readline FSM inline, twice. v0.2.1 review's [medium] suggestion to extract `readOneLine` is **not adopted**. Modules are still small enough that the duplication is bearable, but it's a real cost.
- v0.2.1 suggestion (DI seam on prompts via `{ input?, output? }`) is **not adopted** — prompts still couple directly to `process.stdin`/`process.stderr`. The corresponding test gap remains.
- `formatTable` (lines 66–78) uses `Math.max(...rows.map(...))` for width per column — fine for ccpp's single-digit row counts. For very wide outputs this becomes O(rows × cols × widthScan). Not a bottleneck.
- `promptChoice` (lines 147–171) renders the choice list inside the loop (line 154) — re-rendered on each retry. Cheap; acceptable.

### Style
- Doc comments are now consistently present on every export (compare v0.2.1 where color helpers were undocumented). Asymmetry is gone.
- Naming consistent. `wrap` has its doc explaining the higher-order pattern (line 12).
- No emojis, no TODOs, no dead code.

## Specific issues
- `src/lib/term.ts:85–102, 110–132` — `promptYesNo` and `promptLine` duplicate a 17-line readline FSM. Extract a private `readOneLine(prompt): Promise<string | null>` helper. v0.2.1 nit, still open.
- `src/lib/term.ts:85, 110, 147` — prompts hardcode `process.stdin`/`process.stderr`. No DI seam, hence no unit tests for `promptYesNo` / `promptLine` / `promptChoice`. Adding `opts: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }` is a tiny API surface change that unlocks coverage.
- `src/lib/term.ts:147–171` — `promptChoice` renders the list inside the retry loop (line 154); the choices don't change between attempts. Hoist the format string. Cosmetic.
- `src/lib/term.ts:42–44` — `formatShortSha` is a one-liner that takes any string. If a caller passes a non-SHA, they get a 7-char prefix. No validation. Fine, but documenting "callers must pass a SHA-like string" would prevent misuse.

## Suggestions
- **[medium]** Add tests for the prompt helpers. Minimal API change: add optional `{ input, output }` streams; use `node:stream`.PassThrough in tests. Unblocks `promptYesNo` / `promptLine` / `promptChoice` coverage which is still 0% in v0.2.2 despite being on the user-facing critical path.
- **[medium]** Extract the duplicated readline FSM into a private `readOneLine` helper (carries over from v0.2.1).
- **[low]** Consider moving `formatShortSha` to `git.ts` — domain helper for git SHAs, not a terminal concern. Defer if it adds churn.
- **[low]** Hoist the choice-list format string out of the `promptChoice` retry loop (line 154).

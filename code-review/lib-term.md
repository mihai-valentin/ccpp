# Module: src/lib/term.ts

**LoC**: 109  •  **Test file**: **no** — there is no `src/lib/term.test.ts`

## Purpose
Centralizes terminal-side concerns: ANSI color helpers (`green`, `yellow`, `red`, `dim`, `bold`), color enable/disable plumbing, and the three interactive prompts (`promptYesNo`, `promptLine`, `promptChoice`) used by the CLI commands. All prompts write to stderr so that stdout-piped invocations stay clean.

## Public surface
- Functions: `green`, `yellow`, `red`, `dim`, `bold`, `disableColor`, `promptYesNo`, `promptLine`, `promptChoice`

## Strengths
- `colorEnabled` (lines 5-9) honours both the ecosystem standard (`NO_COLOR`) and the project-specific `CCPP_NO_COLOR`, plus TTY detection. That's the right precedence.
- Prompts go to **stderr** (lines 32, 58) — important so `ccpp ... | jq` doesn't interleave UI text with payload. Often missed in CLI codebases.
- `promptYesNo` defaults to "no" on EOF / empty / unrecognized (lines 41-46), matching the conventional `[y/N]` semantics.
- `promptChoice` (lines 85-109) accepts both numeric index and literal label, which is friendly for keyboard ergonomics, and falls back to default after `maxAttempts` retries instead of looping forever.
- `disableColor` (line 21-23) is idempotent and cheap — sets the env var, which `colorEnabled` re-reads on every wrap call so tests can flip it mid-run.

## Concerns
### Cohesion
Two themes coexist: ANSI styling (lines 1-23) and prompts (lines 25-109). Both are "terminal stuff" but they don't share state and have different testability characteristics. They could split into `term-color.ts` and `term-prompt.ts`. Today's combined form is small enough (109 LoC) to live together.

### Coupling
- Imports stdlib only.
- Used by `cli.ts:45`, all `commands/*.ts`. That's exactly its consumer set.
- Implicit coupling to `process.env`, `process.stderr`, `process.stdout.isTTY`, `process.stdin` (lines 6-8, 22, 32, 58, 33, 59). All accessed directly — no DI seam. This is the source of the testing gap (see Maintainability).

### Maintainability
- **No test file.** `promptYesNo`, `promptLine`, `promptChoice` are stateful (readline + stdin) and untested. The codebase has many `(opts?: { confirm?: ... }) => ...` injection seams (e.g. `applyConfigSet`) precisely because these helpers can't easily be exercised in unit tests. Adding tests would require either (a) a `streams: { input, output }` injection on the prompt helpers, or (b) using `node:stream`'s PassThrough to drive readline. Option (a) is the cheaper unlock.
- `colorEnabled` (lines 5-9) is called once *per styled string* (every `green('foo')` calls it). For long output runs this is fine — the env-var lookup is cheap — but for hot-path rendering it's wasteful. A module-level memoized boolean (invalidated by `disableColor`) would be cleaner; today it's correct because tests can flip the env mid-run, but the perf isn't a bottleneck so it doesn't matter much.
- `promptYesNo` and `promptLine` both build a small `{ resolved, finish, rl.once('line'), rl.once('close') }` finite state machine inline (lines 35-46, 61-77). Same shape, two implementations. Extract a shared `oneLineFromStdin(message: string): Promise<string | null>` helper.
- `promptChoice` (line 89) defaults `maxAttempts = 3` — an unsourced magic number. Acceptable since 3 is conventional, but a named constant `DEFAULT_MAX_PROMPT_ATTEMPTS` makes intent explicit.
- `wrap` (lines 11-13) returns a function that re-checks `colorEnabled()` on every call. That's the right behaviour for the test seam; document it inline.
- The CSI escape `'\x1b['` (line 3) and color codes `'32'` / `'39'` etc. (lines 15-19) are magic literals. They're standard ANSI; a tiny `// SGR codes per ECMA-48` comment would help newcomers.
- No 256-color or truecolor support, but ccpp doesn't need it.

### Style
- Naming is fine; `wrap` is slightly opaque (it's the higher-order color-wrapper factory). A doc comment helps.
- The file has good prompt-level docstrings (lines 25-29, 49-54, 79-83) and zero color-helper docstrings — asymmetric but the prompts deserve more text.
- No emojis, no TODOs.
- `process.stderr.write` is awaited nowhere; node returns boolean for backpressure but for a few-byte UI write that's irrelevant.

## Specific issues
- `src/lib/term.ts:1-109` — no companion test file. Coverage gap relative to every other lib module.
- `src/lib/term.ts:30-47` and `:55-77` — duplicated readline state machine. Extract a `readOneLine(prompt: string): Promise<string>` (returning `''` on EOF) and build both yes/no and line on top.
- `src/lib/term.ts:5-9` — `colorEnabled` is recomputed per wrap call; OK for correctness but slightly wasteful. Memoize behind a "version counter" the env-mutator bumps if it ever becomes a perf issue.
- `src/lib/term.ts:30, 55, 85` — prompts couple to `process.stdin`/`process.stderr` directly. Add an opt-in injection: `promptYesNo(message, opts?: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream })`. Defaults preserve current behaviour; tests pass `PassThrough` streams and assert.
- `src/lib/term.ts:6` — `if (process.env.NO_COLOR) return false` — checks for *any* truthy value of `NO_COLOR`. The NO_COLOR spec says any non-empty value disables color, which `Boolean(process.env.NO_COLOR)` does *almost* honour, except it treats `'false'` (the string) as truthy. That's the spec-compliant behaviour and matches every other tool — confirming, not flagging.
- `src/lib/term.ts:33` and `:59` — `createInterface({ ..., terminal: false })` — explicit `terminal: false` is correct for piped/non-TTY input. Just confirming.
- `src/lib/term.ts:104-106` — error message goes to stderr without color (correctly, since errors should be readable when output is redirected). Consistent.

## Suggestions
- **[high]** Add a `term.test.ts` file. The prompt helpers are user-facing critical paths and currently have zero coverage. Refactor prompts to take optional `{ input, output }` streams (small change) and write tests using `PassThrough`.
- **[medium]** Extract the duplicated readline FSM (`promptYesNo` and `promptLine` share it) into a private `readOneLine` helper.
- **[medium]** Split into `term-color.ts` and `term-prompt.ts` *only if* the planned tests grow large; if both stay <100 LoC, leave them together.
- **[low]** Replace `maxAttempts = 3` with a named constant.
- **[low]** Add a one-line doc on `wrap` explaining that it re-evaluates `colorEnabled` per call (intentional, for test seams).
- **[low]** Add a doc comment on the SGR codes if anyone touches them.

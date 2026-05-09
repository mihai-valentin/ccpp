# Module: src/lib/url.ts

**LoC**: 26  •  **Test file**: yes — `src/lib/url.test.ts` (81 LoC)

## Purpose
Splits a `<url>@<ref>` shorthand string into its URL and ref parts, used by the CLI to accept `ccpp install git@host:o/r@v1.0` style inputs without making the user reach for `--ref`. The function deliberately rejects ambiguous inputs (slashes/colons/whitespace in the ref) and falls back to returning the raw URL unchanged, so the CLI can offer `--ref` as the fallback path.

## Public surface
- Function: `splitUrlRef(input: string): { url: string; ref?: string }`

## Strengths
- Excellent doc comment (lines 1-10) explaining the rule (`@` after the last `/` or `:`) and why it exists (avoid eating SCP-style SSH host or HTTPS auth-in-URL).
- Test coverage maps cleanly onto the documented constraints — `url.test.ts:43-54` exercises the auth-vs-ref disambiguation, `:56-61` exercises the slash-rejects-ref path, `:69-74` covers the multi-`@` case explicitly.
- Minimal surface area: one function, one return shape, no I/O, no dependencies. Pure and easy to reason about.
- Returns `{ url: input }` (without `ref`) on the failure paths rather than throwing — lets the CLI degrade gracefully and ask the user to use `--ref`.

## Concerns
### Cohesion
Single-responsibility, well-named. The only nit: this module sits next to `parseRepoUrl` in `git.ts:27-58` which is also URL-parsing logic. They could plausibly co-live in `url.ts`, leaving `git.ts` purely about process orchestration.

### Coupling
Zero imports — pure-function module. Nothing depends on this except `src/cli.ts:34`, which is exactly right.

### Maintainability
- 26 LoC, one function. There's nothing to maintain.
- The regex `/[\s/:]/` (line 23) is the entire validator. Every rejected character is also covered by a test case. Good.
- Edge cases I checked manually that are not in tests: `'@v1.0'` (whole input is the ref shorthand) — `lastAt = 0`, `pathStart = -1`, condition `0 < -1` false, so we proceed; ref = `'v1.0'`, returns `{ url: '', ref: 'v1.0' }`. That's probably wrong — an empty URL should be returned unchanged. Worth a test + an explicit early-out for `lastAt === 0`.
- `'@'` alone — `lastAt = 0`, ref slice is `''`, line 22 returns `{ url: '@' }`. Acceptable; it's the empty-ref guard.
- Whitespace before `@` (e.g. `' @v1.0'`) — `lastAt = 1`, `pathStart = -1`, condition `1 < -1` false; ref = `'v1.0'`, returns `{ url: ' ', ref: 'v1.0' }`. Trailing/leading whitespace on input is the CLI's problem, but a defensive `input.trim()` early would be safer — the CLI does pass through `argv` strings that have already been split by node's argv parser, so this is unlikely in practice.

### Style
- Naming consistent. `pathStart` reads slightly oddly (it's the latest position considered "still inside the URL") — but the comment explains it.
- No dead code, no TODOs.

## Specific issues
- `src/lib/url.ts:11` — input `'@v1.0'` returns `{ url: '', ref: 'v1.0' }`. An empty URL is meaningless to downstream callers (`cloneOrUpdate('')` will throw "Git URL is empty" at `git.ts:30`, so the failure mode is OK, but it's a poor error). Add `if (lastAt === 0) return { url: input };` after line 12, or assert `slice(0, lastAt).length > 0`.
- `src/lib/url.test.ts` — no test for the `@<ref>`-only input or for whitespace-leading input. Coverage would be tightened by adding both.
- The doc comment at lines 8-9 lists `@` itself as a rejected character, but the regex at line 23 doesn't include `@` — multi-`@` is handled by always splitting on the *last* `@`, which is well-tested but contradicts the prose. Tighten the comment to: "Refs containing `/`, `:`, or whitespace are not allowed via shorthand; multi-`@` inputs split on the last `@`."

## Suggestions
- **[medium]** Add the `lastAt === 0` early-out (or test demonstrating it's intentional).
- **[low]** Reword the doc comment at lines 8-9 to match the actual regex (drop the `@` mention or rephrase to "additional `@` characters").
- **[low]** Add tests for `'@v1.0'` and a leading-whitespace input. Both should be one-liners.
- **[low]** Consider co-locating with `parseRepoUrl` from `git.ts` if a future refactor consolidates URL handling. Don't churn for it.

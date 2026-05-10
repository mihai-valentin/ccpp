# Module: src/lib/url.ts

**LoC**: 29  •  **Test file**: yes — `src/lib/url.test.ts` (88 LoC)  •  **v0.2.2 status**: refactored (small additions)

## Purpose
Splits a `<url>@<ref>` shorthand string into its URL and ref parts so the CLI can accept `ccpp install git@host:o/r@v1.0` style inputs without forcing `--ref`. Pure, no I/O, dependency-free.

## Public surface
- Function: `splitUrlRef(input: string): { url: string; ref?: string }`

## Strengths
- v0.2.1 finding (`'@v1.0'` would return an empty `url`) is **resolved**: line 22's `if (lastAt === 0) return { url: input };` is the exact early-out the previous review asked for, with the corresponding test at `url.test.ts:5–11`.
- The doc comment (lines 1–12) is now clearer about multi-`@` semantics: "splits on the *last* one" is explicit, dropping the v0.2.1 contradiction the reviewer flagged.
- Doc explicitly notes refs containing `/`, `:`, or whitespace are unsupported and points users at `--ref`.
- Zero imports — still a pure-function module with one consumer (`cli.ts`).
- Test coverage maps cleanly onto every documented constraint, including the new lastAt=0 case (line 5–11) and explicit whitespace rejection (line 83).

## Concerns
### Cohesion
Single-purpose, well-named, 29 LoC, one function. Nothing to fix.

### Coupling
Zero imports. Used only by `cli.ts` for the install entry path. Correct boundary.

### Maintainability
- The validator regex `/[\s/:]/` (line 26) is the entire predicate; every rejected character has a corresponding test case (`url.test.ts:63`, `:83`).
- The leading-whitespace edge case (`' @v1.0'` → `{ url: ' ', ref: 'v1.0' }`) flagged in v0.2.1 was deemed CLI-side trim territory and is not closed here; that decision is fine and not regressing.
- 29 lines, no functions, no state — testability is trivial and exhaustive.

### Style
- Doc comment is the strongest in the lib. Good model for future small modules.
- No emojis, no TODOs, no dead code.

## Specific issues
- None. Every concrete v0.2.1 finding is resolved or explicitly out of scope.

## Suggestions
- No actionable suggestions. The module is in great shape.

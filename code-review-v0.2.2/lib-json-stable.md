# Module: src/lib/json-stable.ts

**LoC**: 36  •  **Test file**: no  •  **v0.2.2 status**: NEW in v0.2.2

## Purpose
Deterministic JSON serializer: object keys sorted alphabetically, 2-space indent, no trailing newline. Extracted so `lockfile.ts` and `config.ts` produce byte-identical output for the same logical state, making git diffs against version control meaningful.

## Public surface
- Functions: `stableStringifyValue`

## Strengths
- Resolves v0.2.1 finding ("stable-stringify duplicated between `lockfile.ts:53–79` and `config.ts:456–482` with cosmetic drift") — the two callers now both import from this module (verified via grep).
- 36 LoC, one recursive function. Easy to read top-to-bottom.
- Handles every JSON-relevant input type explicitly: `null`, string, number, boolean, array (empty + non-empty), object (empty + non-empty), and a fall-through (line 35) for `undefined` / function / symbol that returns `'null'`. The fall-through comment ("Shouldn't happen for domain values; callers should not pass these.") names the contract.
- Indent computation uses `indent + 2` for the recursion (lines 16, 24) — the closing bracket sits at the parent indent. Output matches what `JSON.stringify(value, null, 2)` produces *if it sorted keys* — visually identical to `JSON.stringify`-output for callers' eyes.
- Doc comment (lines 1–8) names the consumers and the "byte-identical files for same logical state" property.

## Concerns
### Cohesion
Single-purpose. Right module.

### Coupling
- Zero imports.
- Consumers: `lockfile.ts:3`, `config.ts:3` (verified). Two callers, exactly the extraction's purpose.

### Maintainability
- 36 LoC, single recursive function. Recursion depth is bounded by the JSON nesting; for ccpp's lockfile/config (depth ≤ 4) there's no stack-overflow risk. For arbitrary nested JSON, recursion is theoretically a concern; in practice irrelevant.
- No cycle detection: a self-referential object (`obj.foo = obj`) would recurse forever. JSON has no native cycle support and `JSON.stringify` throws on cycles; this function does not throw — it just recurses indefinitely. For ccpp's curated inputs (config + lockfile), cycles are impossible. Worth one line in the doc to make this an explicit precondition.
- No `replacer` / `reviver` parameter — fine, ccpp doesn't need it.
- `Object.keys(value).sort()` (line 22) does a default lexicographic sort. Keys with non-ASCII characters sort by UTF-16 code unit, which may not match user expectation for, say, mixed-locale strings. ccpp's keys are all ASCII (config keys, source URLs, file paths) so this is fine.
- The fall-through path (line 35) returns `'null'` for `undefined`. `JSON.stringify` *omits* the field instead. Subtle difference: if a caller passes `{ x: undefined }`, this serializer renders `{"x": null}` whereas `JSON.stringify` renders `{}`. Today no caller does this (every config field is either present or omitted at write time), but it's a behavioural difference worth documenting.

### Style
- Doc comment is exactly the right length.
- `indent = 0` default param (line 9) lets callers invoke without thinking about indentation.
- Naming: `stableStringifyValue` is the public API; `value` parameter; `indent`, `nextIndent`, `pad`, `end`, `entries`, `items` — all locally clear.
- No emojis, no TODOs.
- **No test file.** A pure deterministic function is the cheapest place to invest in tests; ~30 LoC covering empty objects/arrays, nested structures, sort order verification, and round-trip via `JSON.parse(stableStringifyValue(x)).should.equal(x)` would be a quick win.

## Specific issues
- `src/lib/json-stable.ts` — no test file. The function is pure and trivial to test exhaustively. The lockfile and config tests cover it indirectly, but a direct test would catch a regression that doesn't surface as a test failure elsewhere (e.g. a serializer edge case in array-of-empty-arrays).
- `src/lib/json-stable.ts:35` — fall-through returns `'null'` for `undefined`, diverging from `JSON.stringify`'s field-omission behaviour. Document the behaviour or filter undefined-valued entries before recursing into objects (line 28). Today no caller depends on this so behaviour is moot.
- `src/lib/json-stable.ts` — no cycle detection. A self-referential value would loop. Document as a precondition in the doc comment.
- `src/lib/json-stable.ts:22` — sort is `Array.prototype.sort()` default (lexicographic by UTF-16). ASCII-only keys are fine; document the assumption if non-ASCII keys ever become a concern.

## Suggestions
- **[medium]** Add `json-stable.test.ts`. ~30 LoC covering null, primitives, empty + non-empty arrays/objects, nested, key sort, undefined handling, and round-trip via `JSON.parse`. Cheap insurance for a foundational module.
- **[low]** Document preconditions in the doc comment: "input must be acyclic; ASCII-friendly keys recommended; undefined-valued fields are rendered as `null` (not omitted)".
- **[low]** Optional: filter undefined-valued entries inside objects (line 28) so the output matches `JSON.stringify`'s omit-undefined behaviour. Defensive only — no caller relies on this today.

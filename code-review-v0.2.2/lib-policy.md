# Module: src/lib/policy.ts

**LoC**: 41  •  **Test file**: yes — `src/lib/policy.test.ts` (65 LoC)  •  **v0.2.2 status**: NEW in v0.2.2

## Purpose
Resolves the effective sync policy and effective auto-accept for a single source given (CLI override, per-source policy, global config, default). Pure functions extracted from `commands/sync.ts` so the precedence matrix is unit-testable in isolation.

## Public surface
- Functions: `effectivePolicy`, `effectiveAutoAccept`

## Strengths
- Both functions are tiny, pure, total over their input domain. `effectivePolicy` is 4 lines of straight-line precedence; `effectiveAutoAccept` is 3.
- Doc comments (lines 3–14, 26–35) lay out the precedence ladder explicitly with rationale ("`pinned` is the safe choice — no upstream surprises"). Readers don't have to chase the call site.
- Test coverage at `policy.test.ts` exercises every level of the precedence:
  - CLI override > per-source > global > default (lines 12, 22, 32, 38, 42)
  - `effectiveAutoAccept`: CLI flag > config > default with a specific test that "CLI flag false does not negate config true" (line 60) — important behaviour pinned.
- Right module to extract: small, pure, frequently-needed by future commands. `commands/status --explain` (mentioned at line 13) would naturally call this.

## Concerns
### Cohesion
Two functions, both about "what's the effective policy at runtime?". Tight, single-purpose.

### Coupling
- Imports types from `./config.js` (no runtime deps). Pure-function module.
- Used by `commands/sync.ts` and `policy.test.ts`. Right consumer set.

### Maintainability
- 41 LoC. Adding a new precedence level (e.g. an env-var override) is a one-line insert.
- The `if (… !== undefined) return …` ladder is repetitive but obviously correct. A table-driven form would obscure the precedence; current shape is strictly better.
- No magic numbers, no string parsing.

### Style
- Naming: `effectivePolicy` / `effectiveAutoAccept` consistent with v0.1.1 vocabulary.
- `effectiveAutoAccept(flag: boolean | undefined, config: CcppConfig)` takes a different argument order than `effectivePolicy(source, config, override)` — `flag` is first vs `override` is third. Minor inconsistency. The `effectiveAutoAccept` signature is `(flag, config)` because there's no per-source dimension; `effectivePolicy` takes `(source, config, override)` because per-source is meaningful. Defensible difference; would benefit from a short note in the doc.
- No emojis, no TODOs.

## Specific issues
- `src/lib/policy.ts:37–41` — `effectiveAutoAccept(flag: boolean | undefined, config)` — `flag === false` does not turn off a config-set `autoAccept: true`. This is documented behaviour (test pins it at `policy.test.ts:60`) but subtle. Consider whether `--no-auto-accept` (passing explicit `false`) should override config; today it doesn't. Worth a one-line doc note explaining the asymmetry, since it's a UX surprise candidate.
- `src/lib/policy.ts:15–24` — `effectivePolicy(source, config, override)` accepts the source as a `ConfigSource` object but only reads `source.policy` (line 21). Could accept `source.policy` directly (typed `SyncPolicy | undefined`) — less coupling to the `ConfigSource` shape. Cosmetic; current form makes the call site read more naturally.

## Suggestions
- **[low]** Document the "explicit false flag does not override config true" asymmetry on `effectiveAutoAccept` — either add a `--no-auto-accept` semantic that clears, or note in the doc that auto-accept is monotonic-on (config + CLI form a logical OR).
- **[low]** Consider taking `policy: SyncPolicy | undefined` directly in `effectivePolicy` rather than the whole `source` object. Defer if call sites read more naturally with the object.

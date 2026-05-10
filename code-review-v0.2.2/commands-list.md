# Module: src/commands/list.ts

**LoC**: 89  •  **Test file**: no — there is no `commands/list.test.ts`. `lockfileRows` is exported, which makes it trivially unit-testable, but no tests exist.  •  **v0.2.2 status**: new (extracted from cli.ts)

## Purpose
Implements `ccpp list`. Reads the lockfile, classifies every installed entry into commands / skills / agents via `lib/layout`, and prints either a JSON shape or a column-aligned table. `lockfileRows` is split out as a pure function so it can in principle be tested without the IO surface.

## Public surface
- `ListRow` (line 9) — type for one rendered row (name, type, sourceUrl, sha, lastSync, destPath).
- `runList(opts)` (line 19) — async void; writes to stdout; throws `UserError` on lockfile read failure.
- `lockfileRows(lockfile, claudeHome)` (line 48) — pure transformer from a Lockfile to a sorted `ListRow[]`.

## Strengths
- The pure-function split (`lockfileRows`) is clean: it takes data, returns data, no IO. The IO wrapper (`runList`) is a thin shell around it. This is the textbook pattern for testable command handlers.
- `lockfileRows` reuses `classifyDestination` from `lib/layout` (line 53) instead of re-classifying paths inline — exactly the v0.2.1 fix the previous review asked for. The "two places independently classify install entries" concern is resolved.
- Skills are correctly collapsed to one row per skill+source pair via the `seenSkills` Set (lines 51, 73–76). The v0.2.1 finding about layout-knowledge duplication between this code and `summarizeInstalledTargets` is now mediated through the shared `classifyDestination` helper (though the two consumers still have different aggregation logic — see Concerns).
- Sort is deterministic (line 87): primary by `name`, tie-break by `type`. Stable for screenshot-style snapshot tests.
- `--json` output (line 26) returns the raw rows array — directly machine-parseable.
- `formatTable` from `lib/term` (lines 35–40) handles column alignment; this file owns nothing about ANSI/width math.

## Concerns

### Cohesion
Excellent — two functions, both about turning a lockfile into a list. No mixed responsibilities.

### Coupling
- Imports `lib/errors`, `lib/layout`, `lib/lockfile`, `lib/term`, `lib/types`, and `commands/shared`. All justified.
- No reach into `lib/git`, `lib/installer`, `lib/manifest`, or any sibling command. Bounded.

### Maintainability
- `runList` (19–41) is short and linear: read → transform → emit. Branching is minimal (json/empty/normal).
- `lockfileRows` (48–89) has three branches per entry (commands / agents / skills). The first two are structurally identical (lines 55–63 and 64–72) — same six fields populated identically except for the literal `'command'` vs `'agent'`. Extracting a tiny `pushFromClassification(rows, cls, entry, destPath)` helper would remove ten lines of duplication. Borderline — the duplication is local and obvious; cite it but don't insist.
- `destPath` for skills is reconstructed via `join(dirs.skillsDir, cls.name)` (line 83) rather than using the original `destPath` from the lockfile entry. That's necessary because skills are directories spanning multiple files, but it means the rendered `destPath` is *synthesised*, not echoed from the lockfile. Worth a one-line comment above line 83 making this distinction explicit — readers comparing JSON output to lockfile contents will otherwise wonder why the path doesn't match.
- The `cls.name.length > 0` guard on skills (line 73) drops malformed skill paths silently. Acceptable defensive coding, but if a future bug installs a malformed skill entry, `list` would just hide it rather than surface the issue. A debug-mode warning isn't necessary now but the silent drop is undocumented.
- `for (const [destPath, entry] of Object.entries(...))` (line 52) iterates in insertion order. The downstream sort makes this irrelevant — but if `seenSkills` ever needed to keep a "first wins" behavior, ordering would matter.

### Style
- Naming is precise: `cls`, `dirs`, `entry`, `seenSkills`. No surprises.
- Doc comments name the "skills collapse to one row" rule (lines 43–47).
- The double `else if` chain (55, 64, 73) is fine at three branches; a `switch` over `cls.kind` would be slightly tighter but loses the structural similarity readers can see at a glance now.
- Direct `process.stdout.write` for JSON (line 26) instead of `log()`. Same `--json` ignores `--quiet` rule as init.ts; same suggestion to comment it.

## Specific issues
- **commands/list.ts:55–72** — the `commands` and `agents` branches are structurally identical except for the `type` literal. Light duplication; consider a `pushRow(kind, cls)` helper if a fourth resource kind is ever added.
- **commands/list.ts:83** — synthesised `destPath` for skills (rebuilt from `claudeHome` + name) doesn't match the per-file paths stored in the lockfile. Add a short comment noting the synthesis is intentional.
- **commands/list.ts:73** — `cls.name.length > 0` guard silently drops malformed skill destinations. Document or surface.
- **commands/list.ts:26** — `--json` write bypasses `log()`/`opts.quiet`. Same convention as init/install/uninstall; one-line comment somewhere central would beat per-file rationale.
- No `commands/list.test.ts`. `lockfileRows` is a pure function with mixed-resource fixtures already available in the lockfile fixtures used by `lib/lockfile.test.ts`. Adding a unit test takes ~30 lines and would protect the layout-classification contract.
- **commands/list.ts:87** — `localeCompare` is locale-sensitive. For deterministic CLI output across environments, consider `localeCompare('en', { sensitivity: 'base' })` or a plain `<`/`>` comparison. Probably fine in practice.

## Suggestions
- **[medium]** Add `commands/list.test.ts` exercising `lockfileRows` with: a mix of commands/skills/agents, a multi-file skill (asserting collapse), a malformed entry (asserting silent drop), and the sort ordering.
- **[low]** Comment line 83 to explain that the skill `destPath` is synthesised from claudeHome + name.
- **[low]** Comment line 73 (or the doc block at 43) to note that skill entries with empty names are silently dropped.
- **[low]** Consider extracting a tiny `pushRow(rows, kind, cls, entry, destPath)` helper if a fourth resource kind ever appears.

## Resolved from v0.2.1
- Layout-classification logic now goes through `classifyDestination` from `lib/layout` (line 53), removing the v0.2.1 "structural knowledge duplicated" concern.
- `lockfileRows` exported as a pure function — testable seam established.
- Lives in its own module — extracted from cli.ts cleanly.

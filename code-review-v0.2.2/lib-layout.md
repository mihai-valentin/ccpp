# Module: src/lib/layout.ts

**LoC**: 59  •  **Test file**: no  •  **v0.2.2 status**: NEW in v0.2.2

## Purpose
Centralizes the three Claude Code subdirectories ccpp manages (`commands/`, `skills/`, `agents/`) plus the inverse classifier (`destPath` under `<claudeHome>/` → which kind?). Replaces hard-coded `'commands'` / `'skills'` / `'agents'` literals previously scattered across `installer.ts`, `diff.ts`, the install-wizard, and `commands/list.ts`.

## Public surface
- Const: `CLAUDE_LAYOUT`
- Types: `ResourceKind`, `ClaudeDirs`
- Functions: `claudeDirs`, `classifyDestination`

## Strengths
- v0.2.1 review's [low] suggestion ("centralize directory names `'commands'`/`'skills'`/`'agents'`") is **resolved** by extracting this module. `CLAUDE_LAYOUT` (lines 9–13) is the single source of truth; `as const` keeps the literal types narrow.
- `ResourceKind = keyof typeof CLAUDE_LAYOUT` (line 15) derives the union from the const, so adding a new managed dir widens the union automatically.
- `claudeDirs(claudeHome)` (lines 24–30) is a tiny convenience that returns the three resolved absolute paths in one shot — exactly the shape `commands/list.ts` and the install-wizard need (verified via grep).
- `classifyDestination` (lines 37–59) is the inverse: given an absolute destPath, return `{ kind, name }` or `null`. Used by the install-wizard tally and `ccpp list`. Path-string-only — no fs calls — pure and testable.
- Doc comments name the *why* (typo prevention across modules) at lines 4–8.

## Concerns
### Cohesion
Two related things: layout constants + a destPath classifier. Both are about "what does the on-disk layout under `~/.claude/` look like and how do we name pieces of it". Right grouping.

### Coupling
- Imports `node:path` only.
- Consumers: `lib/plan.ts`, `commands/install-wizard.ts`, `commands/list.ts` (verified via grep). Right consumer set.
- Pure path-string logic — no fs.

### Maintainability
- 59 LoC, one const, two functions. Trivial to amend if a new managed dir is added.
- `classifyDestination` (lines 37–58) does prefix-string matching with `${dir}/` (lines 42–44). On Windows, `join(claudeHome, 'commands')` returns `…\commands`, but `${dirs.commandsDir}/` appends a forward slash — the prefix match would then fail because the actual destPath uses backslashes. **Latent bug for Windows users.**
- The skills classifier (lines 52–56) uses `split(/[\\/]/)[0]` — handles both separators. Good. But the prefix check on lines 42–44 doesn't have the same defense.
- `name` extraction strips `.md` for commands and agents (lines 47, 51) — correct for the flat-file resource kinds. Skills extract the first path segment (line 55). Reasonable.
- **No test file.** For a path-only pure module this would be cheap (~30 LoC of tests covering Windows + POSIX separators, missing-prefix → null, edge cases).

### Style
- Doc on `CLAUDE_LAYOUT` (lines 3–8) and `classifyDestination` (lines 32–36) is concrete and rationale-bearing.
- `as const` on the const literal is correct.
- No emojis, no TODOs.

## Specific issues
- `src/lib/layout.ts:42–44` — `commandsPrefix = \`${dirs.commandsDir}/\`` hardcodes a forward-slash separator. On Windows, `dirs.commandsDir` will be `\path\to\.claude\commands` and a destPath produced via `join` will use backslashes; the prefix check will silently fail and `classifyDestination` returns `null` for every valid path. The brief stated ccpp ships as a CLI — Windows-friendliness is plausibly in scope for OSS.
- `src/lib/layout.ts` — no test file. A handful of unit tests covering POSIX paths plus one explicit Windows-style fixture would close the platform regression risk.
- `src/lib/layout.ts:45–48` — `replace(/\.md$/, '')` strips the suffix from the basename portion. If someone names a command `foo.md.md` (silly, but allowed), the result is `foo.md` — acceptable, but worth a one-liner test pin if you care.

## Suggestions
- **[medium]** Replace the hardcoded `'/'` in the prefix matchers (lines 42–44) with `path.sep`, or use `path.relative(dirs.commandsDir, destPath)` and check whether the result is non-empty and doesn't start with `..`. The latter is the canonical "is X under Y?" idiom and works on every platform.
- **[medium]** Add `layout.test.ts`. A pure path-only module is the cheapest place to pay for test coverage — covering the three kinds, the null case, and a Windows-style fixture is ~30 LoC.
- **[low]** Document the absolute-path precondition on `classifyDestination` (matches `claudeHome` precondition).

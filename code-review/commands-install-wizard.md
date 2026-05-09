# Module: src/commands/install-wizard.ts

**LoC**: 178  •  **Test file**: yes — `src/commands/install-wizard.test.ts` (278 LoC, 11 cases).

## Purpose
Pure-logic implementation of the first-time interactive install wizard. Owns the prompt-by-prompt state machine that asks the user for URL, ref, sync policy, autoAccept, and hook preference, surfacing the same risk-acknowledgement warnings used by `ccpp config set`. Also exposes `summarizeInstalledTargets` — a post-install report counter shared by `cli.ts`'s wizard report path.

## Public surface
- **Types/interfaces**:
  - `WizardIO` — injected IO surface with four prompt methods (`out`, `promptLine`, `promptChoice`, `promptYesNo`).
  - `WizardPlan` — `{ url, ref?, syncPolicy, autoAccept, installHook }`.
- **Functions**:
  - `runInstallWizard(io: WizardIO): Promise<WizardPlan | null>` — runs the wizard; returns `null` on cancel.
  - `summarizeInstalledTargets(result, claudeHome): { commandCount, skillNames, agentCount }` — tallies post-install file counts.

## Strengths
- IO is dependency-injected via `WizardIO` (lines 9–22). The test file demonstrates this paying off — every wizard test runs in-process with canned answers, no spawn, no stdin mocking.
- The state machine's risk gates loop instead of restart: declining the `latest`-policy warning (line 109 `keeping safer default — pick again`) returns to `promptChoice`, not the top of the wizard. Same pattern at 123 for autoAccept. Good UX, surfaced in the "REGRESSION" test cases.
- `summarizeInstalledTargets` was rebuilt to consume `installed | updated | unchanged` together (lines 152–178) — the JSDoc at 142–151 explains the v0.1.3 bug it was written to fix and the test at install-wizard.test.ts:208–228 pins that regression.
- Doc comment style is excellent throughout — every function has intent, every risk acknowledgement is named, and the `// note: hook runs ccpp sync --auto-accept` line at 137–138 captures a subtle policy interaction.
- Skills are deduplicated by directory name in the summarizer (line 162 `skills = new Set<string>()`), matching how `ccpp list` groups them in `cli.ts:lockfileRows`.

## Concerns

### Cohesion
Mostly tight, but `summarizeInstalledTargets` is doing destination-path classification (commands/ vs skills/ vs agents/ based on prefix matching, lines 156–177) — exactly the same logic that lives in `cli.ts:726–771` (`lockfileRows`). The wizard module is the wrong home for this; both call sites are presentation-layer aggregators of `installed/updated/unchanged` paths and should share one classifier in `lib/installer.ts` or a new `lib/layout.ts`.

### Coupling
- Imports `parseRepoUrl` from `lib/git.js` (line 2) just for URL validation in `askUrl` (line 81). Reasonable but it makes the wizard depend on the git module — if the URL parser is ever moved (e.g. into `lib/url.ts`, where `splitUrlRef` lives), the wizard import has to follow.
- Imports `POLICY_LATEST_WARNING` and `AUTO_ACCEPT_WARNING` from `lib/config.js` (line 1). This is the right call — the warning text is single-sourced. The test asserts on it via `toMatch(/Switching to syncPolicy:latest/)` (test:121), which proves the wiring.
- No circular risks; `commands/install-wizard.ts` is a leaf below `cli.ts`.

### Maintainability
- `runInstallWizard` is 30 lines (40–70), well within bounds.
- `askSyncPolicy` (97–111) and `askAutoAccept` (113–126) both implement a "show warning, then second prompt to confirm" pattern with subtle differences: `askSyncPolicy` loops on decline, `askAutoAccept` returns `false` on decline (line 124) — different control flow for a similar UX. The asymmetry is intentional (declining `latest` should re-pick policy; declining autoAccept should default to false), but it is not immediately obvious from reading the code.
- The empty-message prompt-yes-no calls at 107 and 121 (`io.promptYesNo('')`) lean on the assumption that the warning was just printed via `io.out`. That works but is fragile — a future refactor that reorders calls would silently produce a `[y/N]` with no question. Pass the warning as part of the prompt message, or at least `'Continue?'`.
- `summarizeInstalledTargets` builds `commandsPrefix`, `skillsPrefix`, `agentsPrefix` by string-concatenating `${claudeHome}/commands/` etc. (lines 156–158). Same concatenation in `cli.ts:728–730`. Both should call a shared `claudeLayout(home)` helper.
- `summarizeInstalledTargets` uses `split(/[\\/]/)` at line 173 for cross-platform path splitting. `cli.ts:755` does the same. Worth deduping.
- `WizardPlan` is built at lines 67–69 by conditionally setting `ref` only when defined — same pattern as `cli.ts`'s `ConfigSource` building (cli.ts:152–154, 290, 339, 458–459). A small `withOptional<T, K>(obj, key, value)` helper or just inline-style `{ ...obj, ...(ref !== undefined ? { ref } : {}) }` would standardize this across the codebase.

### Style
- `for (;;)` infinite loops at 73, 98, 114 — idiomatic in TS but `while (true)` is more common in this repo (look at sync.ts, cli.ts — actually neither uses `while (true)` either). Consistency is fine. Worth noting the loop at 113–125 is misleading: `askAutoAccept` only ever runs through once (it returns from inside the loop on every branch — lines 118, 124). The `for (;;)` is dead loop control. Either remove the loop wrapper or genuinely loop on decline (which would match `askSyncPolicy`).
- Naming is good throughout. `ask*` for prompting helpers, `runInstallWizard` for the entry point, `summarizeInstalledTargets` for the tallier.
- Type discipline is solid. No `any`, no `as` casts, no implicit `unknown`.
- The module exports a `Types` re-export through `index.ts` only indirectly — nothing here is exposed publicly except via `cli.ts`. That is fine.

## Specific issues
- **commands/install-wizard.ts:113–126** (`askAutoAccept`): the `for (;;)` loop has no path back to the top — every branch returns. Either it should genuinely loop (matching `askSyncPolicy`'s "decline → keep prompting" flow) or the loop should be removed. As written, the loop wrapper misleads.
- **commands/install-wizard.ts:107, 121**: `io.promptYesNo('')` with empty message relies on the warning having been printed via `io.out` immediately above. Brittle. Pass `'Continue?'` (already used in cli.ts:383).
- **commands/install-wizard.ts:152–178 vs. cli.ts:726–771**: two implementations of "classify a destination path under `~/.claude/` into command/skill/agent". Duplicate structural knowledge.
- **commands/install-wizard.ts:156–158 vs. cli.ts:728–730**: triplicate string concatenation of `claudeHome + '/' + (commands|skills|agents)`. One `lib/layout.ts:claudeLayout(home)` helper would replace both.
- **commands/install-wizard.ts:67–69**: conditional optional-field assignment idiom is repeated five+ times across cli.ts and this file. Standardize on a helper or one inline pattern.

## Suggestions
- **[medium]** Pull the destination-path classifier (`summarizeInstalledTargets` body + `cli.ts:lockfileRows` logic) into `lib/layout.ts` exporting `claudeLayout(home): { commandsDir, skillsDir, agentsDir }` and `classifyDestination(path, layout): { type: 'command'|'skill'|'agent', name } | null`. Both call sites then just iterate and tally.
- **[medium]** In `askAutoAccept` (lines 113–126), either remove the `for (;;)` wrapper (it never re-iterates) or implement a real "decline → re-ask" loop matching `askSyncPolicy` for symmetry. Update the corresponding test (install-wizard.test.ts:124–140) accordingly.
- **[low]** Replace the empty-string `io.promptYesNo('')` calls at 107 and 121 with `'Continue?'` so the wizard transcript reads sensibly even if the warning ordering ever shifts.
- **[low]** Minor: at line 84, the URL validation error path `io.out(\`  \${yellow('!')} \${(err as Error).message}\`)` casts the caught value to `Error`. `parseRepoUrl` always throws an `Error`, so this is safe — but a `try { parseRepoUrl(url) } catch (err: unknown) { if (err instanceof Error) ... }` narrowing would be more idiomatic and matches the strict-by-default mode the rest of the repo uses.
- **[low]** Add a JSDoc tag `@returns null when the user cancels at the final confirm` on `runInstallWizard` — the cancel path is non-obvious from the signature alone, even though the body documents it.

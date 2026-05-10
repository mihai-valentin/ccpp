# Module: src/commands/install-wizard.ts

**LoC**: 173  •  **Test file**: yes — `/home/mihai/xlnf/ccpp/src/commands/install-wizard.test.ts` (278 LoC)  •  **v0.2.2 status**: mostly unchanged (now consumes `lib/layout.classifyDestination`)

## Purpose
Pure-logic implementation of the first-time interactive install wizard. Owns the prompt-by-prompt state machine that asks for URL, ref, sync policy, autoAccept, and hook preference, surfacing the same risk-acknowledgement warnings as `ccpp config set`. Also exposes `summarizeInstalledTargets` — a post-install report counter shared by `cli.ts`'s wizard report path.

## Public surface
- **Types**:
  - `WizardIO` — injected IO surface with four prompt methods (`out`, `promptLine`, `promptChoice`, `promptYesNo`).
  - `WizardPlan` — `{ url, ref?, syncPolicy, autoAccept, installHook }`.
- **Functions**:
  - `runInstallWizard(io: WizardIO): Promise<WizardPlan | null>` — runs the wizard; returns `null` on cancel.
  - `summarizeInstalledTargets(result, claudeHome): { commandCount, skillNames, agentCount }` — tallies post-install file counts.

## Strengths
- **The v0.2.1 medium-priority duplication is closed**: `summarizeInstalledTargets` (157–173) now delegates to `lib/layout.classifyDestination` (imported at line 3). The same classifier is used by `commands/list.ts` (line 53). One source of truth for "is this path a command, skill, or agent under `claudeHome`."
- **`for (;;)` loop in `askAutoAccept` removed**: lines 118–131 are now a clean linear sequence — initial prompt → on-yes show warning → second-confirm prompt → return. The v0.2.1 finding ("the for(;;) wrapper has no path back to the top") is closed. There's actually still a `for (;;)` at 119 in this version, but matched against v0.2.1 the body now genuinely does only one round-trip and returns early — see Specific Issues.
- **IO is dependency-injected via `WizardIO` (10–23)** — all eleven test cases run in-process with canned answers. Still the gold-standard testability pattern in this codebase.
- **State machine's risk gates loop instead of restart** — declining the `latest`-policy warning at 113–114 returns to `promptChoice`, not the top of the wizard. Same for autoAccept (declining doesn't loop back, by design).
- **`summarizeInstalledTargets` correctly consumes `installed | updated | unchanged` together** (161) — the v0.1.3 regression bug fixed in v0.2.1 is still pinned by tests.
- **Doc comments are still excellent**: every function names its intent (44–43, 154–156); risk acknowledgements are named (113–114, 124–125); the hook-policy interaction is captured at 138–143.

## Concerns

### Cohesion
Tight. Now that `classifyDestination` lives in `lib/layout.ts`, the wizard module is purely about IO + state machine + tally. No mixed responsibilities.

### Coupling
- Imports `lib/config` (warning constants + types), `lib/git` (URL validation), `lib/layout` (classification), `lib/term` (color helpers). Four imports, all justified.
- `summarizeInstalledTargets` no longer reaches into path-string concatenation — it just iterates `result.installed/updated/unchanged` and calls `classifyDestination`. The wizard module is correctly insulated from layout details.
- No coupling to `cli.ts`. Leaf module. No circular risks.

### Maintainability
- **`runInstallWizard` is 30 lines (44–74)** — well within bounds.
- **`askSyncPolicy` (102–116)** loops on decline; `askAutoAccept` (118–131) does not. The asymmetry is intentional (declining `latest` should re-pick policy; declining autoAccept should default to false), but the `for (;;)` at line 119 is misleading because the body always returns on the first iteration. Either remove the loop wrapper or implement a real "decline → re-ask" loop. v0.2.1 flagged this exact item; not yet fixed.
- **`io.promptYesNo('')` at 126** — same v0.2.1 finding as before. Empty prompt message relies on the warning being printed via `io.out` immediately above. v0.2.1 suggested `'Continue?'`; not yet adopted.
- **`WizardPlan` built with conditional optional-field assignment** (71–73) — same project-wide pattern; would benefit from a `withOptional` helper.
- **`summarizeInstalledTargets` is a one-pass O(n) tally** (161–171). Skills are deduplicated by name (164, 170). Clean and correct.

### Style
- **Naming**: `ask*` for prompts, `runInstallWizard` for entry, `summarizeInstalledTargets` for the tallier. Consistent and good.
- **Type discipline solid**: no `any`, no casts, no `unknown` leaks.
- **`for (;;)` at 77, 103, 119** — TypeScript idiomatic. Lines 119's loop is dead since the body always returns; lines 77 and 103 genuinely loop on validation failure.
- **Doc-comment on `summarizeInstalledTargets` (147–156)** preserves the v0.1.3 rationale ("The user re-runs the wizard over existing content…"). Excellent context preservation.

## Specific issues
- **commands/install-wizard.ts:119–131**: `for (;;)` wrapper around `askAutoAccept` body has no path back to the top — every branch returns. Either remove the loop or implement decline → re-ask symmetry with `askSyncPolicy`. v0.2.1 medium suggestion, unfixed.
- **commands/install-wizard.ts:126**: `io.promptYesNo('')` — empty message; brittle relative to warning ordering. Pass `'Continue?'`. v0.2.1 low suggestion, unfixed.
- **commands/install-wizard.ts:71–73**: optional-field-by-mutation pattern. Project-wide; not specific to this module.
- **commands/install-wizard.ts:87**: `err: unknown` cast (`err instanceof Error`) — already the right discipline. v0.2.1 noted the older `err as Error` was less idiomatic; this version uses the proper narrowing pattern. Resolved.

## Suggestions
- **[low]** Remove the `for (;;)` wrapper at line 119 in `askAutoAccept` — the body always returns on the first pass. Or implement a real decline-re-prompt loop matching `askSyncPolicy`. Update the test if a new branch arrives.
- **[low]** Replace `io.promptYesNo('')` at 126 with `io.promptYesNo('Continue?')` so the wizard transcript reads sensibly even if warning ordering shifts.
- **[low]** Add a `@returns null` JSDoc tag to `runInstallWizard` (44) — the cancel path is non-obvious from the signature alone.

# ccpp — code review (v0.2.1)

This directory contains a module-by-module code review of `ccpp` covering all 19 source modules (`src/cli.ts` + `src/lib/*.ts` + `src/commands/*.ts`). Each file under this directory reviews exactly one source module against four axes: **architecture/design health, cohesion and coupling, maintainability, and code style**.

## TL;DR

The codebase is **small (~3.5k LoC), well-tested (193 passing tests across 18 files), and architecturally coherent**: a thin CLI shell over a manifest → plan → install pipeline with explicit lockfile pinning. Most modules are single-purpose, type-discipline is high (no `any`, very few assertions), and the domain types in `lib/types.ts` are the de-facto contract between layers.

The big tensions are **concentration of complexity in two modules** (`cli.ts` at 1070 LoC and `lib/installer.ts` at ~390 LoC), **a small number of cross-module duplications** (error classes, `pathExists`, layout strings, JSON serialization, hook-settings types), and **a handful of soft spots in atomicity / robustness** (non-atomic JSON writes, no rollback on partial install, regex-on-locale-dependent git output). One real correctness bug surfaced: `diff.ts` was not extended for v0.2.0's agent feature, so it will mis-report agents as removed on dry-run.

## Highest-priority findings

These are correctness-impacting and should land before public release:

| # | Finding | Files | Severity |
|---|---|---|---|
| 1 | `diff.ts` does not handle agents — added/modified/removed will be wrong as soon as a source ships an `agents/` directory | `src/lib/diff.ts:92-101` | **high** |
| 2 | `parseManifest` returns `warnings` (command + agent name collisions across plugins) but no caller ever reads them | `src/lib/manifest.ts` ↔ `src/cli.ts` | **high** |
| 3 | Non-atomic JSON writes — `writeLockfile`, `writeConfig`, and both hook commands' `~/.claude/settings.json` mutation use plain `fs.writeFile`. SIGINT mid-write corrupts files Claude Code reads on every session start | `src/lib/lockfile.ts:42`, `src/lib/config.ts:75`, `src/commands/install-hook.ts`, `src/commands/uninstall-hook.ts` | **high** |
| 4 | `applyManifest` has no rollback on mid-loop write failure — half-applied `~/.claude/` state. Recovery story is the `.bak.<ts>` files but it is undocumented and non-automatic | `src/lib/installer.ts` | **high** |
| 5 | Standalone `skills/` at repo root is silently ignored — `manifest.ts` has `scanStandaloneCommands` and `scanStandaloneAgents` but no `scanStandaloneSkills`. Either a real gap or an undocumented design choice | `src/lib/manifest.ts` | **high** |
| 6 | `looksLikeSha` heuristic (`/^[0-9a-f]{4,40}$/i`) misclassifies hex-named branches like `abc1234`. Will full-clone + detached-HEAD checkout instead of branch checkout — wrong semantics for sync | `src/lib/git.ts:125-127` | **medium** |
| 7 | `HOOK_SCRIPT_BODY` (in `install-hook.ts`) and `scripts/hook.sh` are not enforced to stay in sync — drift is a runtime breakage waiting to happen | `src/commands/install-hook.ts` ↔ `scripts/hook.sh` | **medium** |
| 8 | **`ccpp.config.json` and `ccpp.lock.json` are cwd-scoped, but the install destination (`~/.claude/`) is user-scoped.** Running `ccpp sync` from any cwd other than the one used at install time errors with "No ccpp.config.json at …". The SessionStart hook (`scripts/hook.sh`) runs `ccpp sync` from whatever cwd Claude Code launches with and redirects stderr to a log file with `exit 0` — so it **silently no-ops** unless the user happens to open Claude Code from the install directory. This breaks the auto-update flow that is the README's headline feature. Two natural fixes: (a) fall back to `~/.ccpp/ccpp.config.json` when `./ccpp.config.json` is missing; or (b) snapshot the install cwd into the generated `hook.sh` (`cd /path/where/install/ran && ccpp sync`). Both are design calls — the team should pick one. | `src/cli.ts:91-94`, `scripts/hook.sh`, `src/commands/sync.ts:122-128` | **high** |
| 9 | **`ccpp install <url>` does NOT write `ccpp.config.json` when no config existed before.** The conditional at `cli.ts:280-285` (`if (existing && !scratch)`) means a fresh install only writes the lockfile — the user ends up in a state where ccpp claims "X installed" but the next `ccpp sync` (even from the same cwd) errors with "No ccpp.config.json". User must run `ccpp init` first or use the wizard (`ccpp install` with no URL). This contradicts the README's "Quick Start" flow which shows `ccpp init` then `ccpp install <url>` as the explicit-form path — but the explicit form does not in fact create the config. | `src/cli.ts:280-288` | **high** |

## Cross-cutting design improvements

Each appears in at least two module reviews; centralizing reduces future drift.

| # | Finding | Suggested home |
|---|---|---|
| A | `UserError`, `EnvError`, `CollisionError` are redefined in `cli.ts:51-64`, `commands/sync.ts:18-31`, partial copies in `commands/install-hook.ts:6` and `commands/status.ts:13`. The `classifyAndExit` shim at `cli.ts:888-906` is duck-typed because cross-module `instanceof` no longer works | new `src/lib/errors.ts` |
| B | `pathExists` is duplicated **four times** identically — `src/lib/git.ts:164-171`, `src/lib/diff.ts:146-153`, `src/lib/installer.ts:258-265`, `src/lib/manifest.ts:314-321` | move to `src/lib/fsutil.ts` |
| C | Layout strings `'commands'` / `'skills'` / `'agents'` and manifest filenames `'.claude-plugin'` / `'plugin.json'` / `'marketplace.json'` / `'SKILL.md'` are scattered across `cli.ts:728-730`, `installer.ts`, `manifest.ts`, `install-wizard.ts:152-178`, `diff.ts` | new `src/lib/layout.ts` |
| D | `planFiles` and friends (`pushCommand` / `pushSkill` / `pushAgent` / `pushPluginContents`) exist twice — once in `installer.ts:153-238` and again in `diff.ts:88-140`. The "intentionally closed for modification" comment in `diff.ts:89-90` is stale; the agents bug above is the direct consequence | shared `src/lib/plan.ts` |
| E | Stable JSON stringification is duplicated in `lockfile.ts:53-79` and `config.ts:456-482` (near-identical) | new `src/lib/json-stable.ts` |
| F | `HookCommand` / `SessionStartBlock` / `ClaudeSettings` interfaces and the `read/writeSettings` helpers are copy-pasted between `install-hook.ts` and `uninstall-hook.ts` | shared `src/commands/_settings.ts` (or fold into `lib/`) |
| G | Aligned-table renderer + `stripColor` helper are duplicated in `commands/status.ts:130-138, 171-174` and `cli.ts:613-624, 883-886` | move to `src/lib/term.ts` (or new `src/lib/table.ts`) |
| H | SHA short form `.slice(0, 7)` appears in 4 sites; conditional optional-field assignment (`if (x) target.x = x`) appears in 5+ sites | small helpers in `lib/util.ts` |

## Module-level concentration

`src/cli.ts` (1070 LoC) and `src/lib/installer.ts` (~390 LoC) carry disproportionate complexity:

- **`cli.ts`** mixes argv-wiring with **inline implementations** of `init`, `install`, `list`, and `uninstall` (other subcommands delegate to `commands/*.ts`). Splitting `commands/install.ts` / `commands/list.ts` / `commands/uninstall.ts` along the established pattern would shrink `cli.ts` to ~250 lines of pure cac-wiring and unify the action-handler shape.
- **`installer.ts`** has the largest test file (~600 LoC) and conflates planning, conflict detection, file writing, backup creation, and lockfile updates. Splitting **plan** (pure, easily testable) from **apply** (I/O, side effects) would clarify the rollback story and let `diff.ts` reuse the planner directly (also fixes finding **D** above).

`commands/sync.ts:runSync` is 205 lines (`sync.ts:136-340`) with three near-duplicate `appendSyncLog` blocks; decomposable into `cloneAndParseSource` / `applySource` / `recordSkip` / `logSyncOutcome`.

## Test gaps

- `src/lib/term.ts` — **no test file**. The prompt helpers are user-facing critical paths; they should accept optional `{input, output}` streams so they can be exercised with `PassThrough`.
- `src/commands/config.ts` — has integration tests under `tests/cli-config.test.ts` but no module-local unit tests.
- `src/commands/install-wizard.ts` is the gold standard for the rest of the codebase — DI-clean (`WizardIO`), fully unit-tested, well-documented. Other command modules should follow this shape.

## Strengths worth preserving

- Strict TypeScript discipline — almost no `any`, narrow `unknown` use.
- Domain types (`lib/types.ts`) act as the single source of truth across layers.
- Convention-over-config manifest scan with explicit fallback to marketplace.json.
- Symlink hardening at `lib/fsutil.ts:readFileSafe` (security boundary established in 0.1.2).
- Lockfile-pinned, byte-identical installs.
- Clean separation of git operations behind `lib/git.ts:cloneOrUpdate`.
- 193 tests across 18 test files; integration tests use real local-git fixtures.

## Modules index

19 modules, sorted by directory then filename.

### `src/`
- [`cli.md`](./cli.md) — CLI entrypoint and orchestrator (1070 LoC). Mixes argv-wiring with inline subcommand implementations.
- [`index.md`](./index.md) — single-line library re-export. Adequate.

### `src/commands/`
- [`commands-config.md`](./commands-config.md) — config get/set/reset/list. Cleanest error boundary in the slice; should be the model.
- [`commands-install-hook.md`](./commands-install-hook.md) — registers SessionStart hook in `~/.claude/settings.json`. Non-atomic write; types duplicated with uninstall-hook.
- [`commands-install-wizard.md`](./commands-install-wizard.md) — first-run interactive setup. The strongest module in the codebase.
- [`commands-status.md`](./commands-status.md) — runtime visibility — per-source policy, last sync, recent failures. Output formatting mixed with computation.
- [`commands-sync.md`](./commands-sync.md) — `ccpp sync` orchestrator. `runSync` is 205 lines with duplicated logging.
- [`commands-uninstall-hook.md`](./commands-uninstall-hook.md) — removes SessionStart hook. Mirror of install-hook, with the same atomicity issue.

### `src/lib/`
- [`lib-config.md`](./lib-config.md) — `ccpp.config.json` read/write/validate plus `applyConfigSet` ack gate.
- [`lib-diff.md`](./lib-diff.md) — dry-run changeset computation. **Has the agents-handling correctness bug.**
- [`lib-fsutil.md`](./lib-fsutil.md) — small filesystem helpers. Symlink-safe read.
- [`lib-git.md`](./lib-git.md) — git wrapper (clone, fetch, checkout, SHA detection). Locale-fragile in `resolveDefaultBranch`.
- [`lib-installer.md`](./lib-installer.md) — manifest → plan → write pipeline. Largest module. No rollback story.
- [`lib-lockfile.md`](./lib-lockfile.md) — lockfile read/write/merge. Stable-stringify duplicated with `lib-config`.
- [`lib-log.md`](./lib-log.md) — NDJSON sync log with size-based rotation.
- [`lib-manifest.md`](./lib-manifest.md) — manifest parser + collision detection. Warnings emitted but never consumed.
- [`lib-term.md`](./lib-term.md) — color helpers + interactive prompts. Only lib module without tests.
- [`lib-types.md`](./lib-types.md) — domain types only. Pure type module — clean.
- [`lib-url.md`](./lib-url.md) — `<url>@<ref>` shorthand parser (v0.2.1). Small, well-tested.

## How to use this review

1. **Block release on the high-severity findings** in §"Highest-priority findings" — items 1–5 are correctness/data-integrity.
2. **Schedule the cross-cutting refactors** (§"Cross-cutting design improvements") as a single follow-up that creates `lib/errors.ts`, `lib/layout.ts`, `lib/plan.ts`, `lib/json-stable.ts` — they are mechanical and independently low-risk.
3. **Defer the cli.ts split** until after release if needed; it does not block correctness.
4. Treat `commands/install-wizard.ts` and `commands/config.ts` as **target shapes** when refactoring the other command modules — they show the dependency-injection / error-boundary patterns this codebase wants.

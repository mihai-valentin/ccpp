# Changelog

All notable changes to this project will be documented in this file.

## [0.2.2] - 2026-05-10

The OSS-readiness release. Closes every high-severity finding from the v0.2.1 internal code review and lands a substantial architectural cleanup. No breaking changes for existing repos with `./ccpp.config.json` checked in.

### Bug fixes

- **`ccpp install <url>` and `ccpp init` now default to user-scoped config at `~/.ccpp/ccpp.config.json`** (override with `$CCPP_HOME`). Previously the config defaulted to the cwd, which broke the SessionStart auto-update flow — the hook runs from whatever directory Claude Code launches with, so a config landed in `~/projects/A` was invisible if the user opened Claude Code from `~/projects/B`. The hook silently exited 0 (stderr piped to a log) so the failure was invisible.
- **`ccpp install <url>` always writes a config** (unless `--scratch`). The previous behavior wrote only the lockfile when no config existed, leaving the user in a state where the next `ccpp sync` errored with `No ccpp.config.json`.
- **Commit-SHA refs are now classified via `git ls-remote`, not a hex-shape heuristic.** A branch literally named like a SHA (e.g. `abc1234`) used to silently misroute through the SHA path: detached-HEAD checkout, no `reset --hard origin/<ref>` on subsequent syncs — so upstream branch tip moves never landed. Now `git ls-remote --exit-code <url> refs/heads/<ref> refs/tags/<ref>` is authoritative; auth/network failures re-throw with a clear diagnostic instead of silently routing to the SHA path.
- **`applyManifest` is now transactional via a two-phase staging tree.** Phase 1 reads source bytes, classifies each plan item, and stages everything to write under `<claudeHome>/.ccpp-staging-<id>/`. Phase 2 atomic-renames each staged file into place (with a `.bak.<ts>` of any pre-existing differing target). A phase-1 failure removes the staging tree and leaves `~/.claude/` untouched. Replaces the previous in-place-write loop that left half-applied state on mid-loop failure.
- **`diff.ts` now handles agents.** The dry-run summary used to misreport plugin and standalone agents as `removed` because the planner duplicate in `diff.ts` was never updated for the v0.2.0 agents feature. The shared planner (see Architecture) eliminates the drift class entirely.
- **Standalone `skills/` at the repo root is now discovered.** The parser had `scanStandaloneCommands` and `scanStandaloneAgents` but no `scanStandaloneSkills`; top-level skills directories were silently ignored. Symmetric scanner + collision warning added.
- **Manifest warnings are surfaced.** Cross-plugin name collisions (commands, skills, agents) now print to stderr during `ccpp install` and `ccpp sync`. They were emitted by the parser but no caller read them.
- **`~/.claude/settings.json`, `ccpp.config.json`, and `ccpp.lock.json` writes are atomic.** All three go through `writeFileAtomic` (temp + rename) — a SIGINT mid-write no longer leaves a torn JSON file that the next read rejects.
- **Strict per-entry lockfile validation.** A hand-edited lockfile with a malformed entry (missing field, non-string field, non-ISO timestamp) now errors at parse time with a key-path message, instead of crashing downstream.
- **`looksLikeSha` documentation + `LC_ALL=C` for git output.** Locale-fragile regex parses on git output (`set to <branch>`) are now locale-independent. Hex-named-branch limitation is documented at the function and the `--ref` help.

### Features

- **`--project` flag** on `init` and `install` forces project-scoped writes (`./ccpp.config.json`). Use it when committing the config to a team repo. Default is user-scope; existing project-scope configs win on read.
- **Config-path precedence** is now: `--config <path>` > `--project` > `./ccpp.config.json` (if it exists) > `~/.ccpp/ccpp.config.json`. The lockfile is co-located with the config unless `--lockfile <path>` overrides.

### Architecture

- **`src/cli.ts` shrank from 1093 → ~390 lines.** Inline implementations of `init`, `install`, `list`, and `uninstall` moved to `src/commands/init.ts`, `src/commands/install.ts`, `src/commands/list.ts`, and `src/commands/uninstall.ts` — matching the existing pattern for `sync`, `config`, `status`, and the hooks. Cli.ts now does only argv wiring + thin glue + error classification.
- **`src/lib/plan.ts`** — single source of truth for "manifest item → destination path". Both `installer.applyManifest` and `diff.computeChangeset` import it; the planner duplication that caused the agents bug is eliminated.
- **`src/lib/policy.ts`** — `effectivePolicy` and `effectiveAutoAccept` extracted with a unit-tested precedence matrix.
- **`src/lib/errors.ts`** — `UserError`/`EnvError`/`CollisionError` and the `EXIT` codes consolidated. `cli.ts:classifyAndExit` uses `instanceof` instead of duck-typing.
- **`src/lib/layout.ts`** — `CLAUDE_LAYOUT` constants and `classifyDestination()` helper. Hardcoded `'commands'` / `'skills'` / `'agents'` strings removed from cli.ts, installer.ts, manifest.ts, install-wizard.ts, diff.ts.
- **`src/lib/claudeSettings.ts`** — `ClaudeSettings` types and `readSettings`/`writeSettings`/`isCcppBlock` helpers (atomic). Removes ~100 lines of copy-paste between install-hook.ts and uninstall-hook.ts.
- **`src/lib/json-stable.ts`** — deterministic JSON serializer extracted from the lockfile + config copies.
- **`src/lib/fsutil.ts`** gains `pathExists` (was duplicated 4×) and `writeFileAtomic`. `readFileSafe` rewritten to use `O_NOFOLLOW` — opens, type-checks, and reads in a single atomic syscall, fully closing the lstat-then-read TOCTOU window.
- **`runSync` decomposed** from a 205-line orchestrator with three duplicate `appendSyncLog` blocks into a 68-line orchestrator + named per-phase helpers (`syncOneSource`, `cloneAndParseSource`, `applySource`, `recordSkip`, `logSyncError`).
- **`emitHuman` (status.ts) split** into `emitSourcesTable` and `emitRecentEvents`, both with an injected `WriteLine` for testable rendering.

### Build / hardening

- **Version inlined at build time** via `tsup --define`. The runtime no longer reads `package.json` (drops `readFileSync`, `__dirname`, the silent `'0.0.0'` fallback). Works the same under CJS and ESM.
- **`readFileSafe` `maxBytes` cap** — defensive 50 MB default, configurable per-call. Refuses adversarial multi-GB blobs from a malicious source.
- **`backupStamp`** appends 4 hex chars of randomness to avoid collisions when two backups land in the same millisecond.
- **`HOOK_SCRIPT_BODY` ↔ `scripts/hook.sh` parity test** — the embedded copy and the docs copy must run the same commands. Drift used to be silent.

### Tests

213 → **246 tests** across **21 files**. Notable additions: `lib/plan.test.ts` (planner in isolation), `lib/policy.test.ts` (precedence matrix), `lib/term.test.ts` (color + table), `lib/url.test.ts` (the v0.2.1 shorthand parser, edge cases), per-entry lockfile validation cases, transactional-rollback regression cases, ls-remote ref classification, `emitHuman` renderer cases, sync-from-different-cwd regression for the user-scope fallback.

## [0.2.1] - 2026-05-09

- Feature: **`<url>@<ref>` shorthand** on `ccpp install` and `ccpp init --source`. `ccpp install git@bitbucket.org:my/repo@v1.0.0` is equivalent to `ccpp install git@bitbucket.org:my/repo --ref v1.0.0`. Works with branches, tags, and full or short commit SHAs. The trailing `@<ref>` is recognized only when the `@` appears after the last `/` or `:`, so SCP-style SSH URLs (`git@host:path`) and HTTPS auth (`https://user:pass@host/path`) keep working unchanged. Refs containing `/` (e.g. `feature/foo`) can't ride the shorthand — fall back to `--ref feature/foo`.
- Feature: **commit-SHA refs are now actually supported.** Previously `--ref <sha>` failed because the underlying clone path used `git clone --depth 1 --branch <ref>`, which only accepts named refs. ccpp now detects SHA-shaped refs and switches to a non-shallow clone with a plain `git checkout <sha>` (auto-unshallowing existing shallow caches when needed). Branch and tag refs continue to use the shallow `--branch` path — same fast clone as before.
- CLI: passing `<url>@<ref>` and `--ref` together errors out (exit 1) when they disagree. Identical refs are accepted as a no-op.
- Tests: 13 new cases — 10 unit tests for the URL parser (SCP, HTTPS, HTTPS-with-auth, mixed forms, slash-in-ref fallback, edge cases), and 3 CLI-level integration tests (commit-pin happy path, ref-conflict error, matching-ref no-op).

## [0.2.0] - 2026-05-07

- Feature: **subagent support**. ccpp now discovers and installs Claude Code subagents alongside commands and skills. Source convention is `agents/<name>.md` at repo root for standalone agents and `plugins/<name>/agents/<name>.md` for plugin-bundled agents — same shape as `commands/`. Files install to `~/.claude/agents/<name>.md`; Claude Code auto-discovers them, no `/reload-plugins` needed. Existing repos without an `agents/` directory keep working unchanged — agents are purely additive.
- Manifest: `ResolvedManifest` gains `standaloneAgents`; `PluginManifest` gains `agents`. New `agent-name-collision` warning when a standalone agent shares a name with a plugin-scoped one (parallel to the existing command warning). Cross-class collisions (e.g. command + agent both named `code-reviewer`) are intentionally **not** flagged — different Claude Code namespaces.
- Installer: agents flow through the same plan-and-write pipeline as commands/skills — same conflict detection, same `--prefer` resolution, same `.bak.<timestamp>` overwrites, same lockfile shape (no schema bump needed; `LockInstalledEntry` is path-keyed).
- CLI: `ccpp list` now includes an agent type alongside commands and skills. The install-summary line reports `X command(s), Y skill(s), Z agent(s)`.
- Tests: 5 new unit/integration cases — agent discovery (standalone + plugin), agent-name collision warning, agent installer happy path, cross-source agent collision, install-wizard agent counting. Existing `ai-plugins-dev-shape` end-to-end fixture extended with agents on both standalone and plugin paths.

## [0.1.5] - 2026-04-23

- Feature: `ccpp install <url> --prefer-latest` persists `policy: latest` on the source entry being added, so future `ccpp sync` runs pull the newest commit for that vendor without needing a global flip. Per-source only — does not touch the global `syncPolicy` default.
- Feature: `ccpp install <url> --yes` auto-confirms every prompt during this install run — the first-enable risk acknowledgement for `policy: latest`, plus any collision resolution (incoming wins). One-shot; does **not** persist `autoAccept` globally.
- CLI: `--prefer-latest --yes` together give a one-command hands-off install: `ccpp install <url> --prefer-latest --yes`. On a TTY, `--prefer-latest` alone still prompts for the risk ack; on a non-TTY without `--yes`, it errors out with a hint pointing at `--yes`. `--prefer-latest --scratch` is rejected since scratch skips config writes.
- Tests: four new CLI tests — persist policy+ack shape; auto-resolved collisions on re-install; `--scratch` rejection; non-TTY hint.

## [0.1.4] - 2026-04-23

- Fix: install wizard's post-install report now counts `installed + updated + unchanged` files, not just newly-created ones. Re-running the wizard over already-populated `~/.claude/` previously showed "0 command(s), 0 skill(s)" even though `ccpp list` correctly saw the full set. Report also now carries a 3-way breakdown line under the total.
- Library: counting logic extracted into pure `summarizeInstalledTargets()` in `src/commands/install-wizard.ts` and pinned by a named regression test plus shape tests.
- Docs: vendor-agnostic example URLs across README, `docs/exit-codes.md`, `docs/auto-update.md`, and test fixtures. Test author-name fixtures use "Example Org AI Tooling".

## [0.1.3] - 2026-04-23

- Feature: `ccpp install` with no URL now launches an interactive first-time setup wizard on a TTY — prompts for source URL, `syncPolicy`, `autoAccept`, and whether to install the SessionStart hook, then writes `ccpp.config.json`, clones the source, installs, registers the hook, and prints a "what's next" guide. Runs only on the very first install (no existing `ccpp.config.json`); subsequent runs with no URL error out cleanly pointing at `ccpp install <url>`.
- Feature: interactive collision resolution — when two sources supply the same command/skill name, ccpp now prompts per-collision (`keep` / `use-incoming` / `cancel`) on a TTY and records the winner under `preferredSources`. Non-interactive contexts keep the exit-`3` behaviour so scripts fail loudly.
- CLI: `ccpp install` changed from `<url>` (required) to `[url]` (optional). The explicit-URL form is unchanged. `--ref`, `--prefer`, and `--scratch` now error if passed without a URL.
- Library: new `promptLine` and `promptChoice` helpers in `src/lib/term.ts`; first-run setup state machine extracted into `src/commands/install-wizard.ts` with an injectable `WizardIO` so the logic is testable without a pty.
- Docs: Quick Start gained a "Fastest path — interactive wizard" section; `docs/exit-codes.md` updated to reflect the TTY-aware collision path.

## [0.1.2] - 2026-04-23

- Security: refuse to follow symlinks when reading files from a source repo — a crafted source can no longer trick ccpp into reading outside its clone directory.
- Repo: first-push hygiene — `.gitattributes`, `.editorconfig`, `.nvmrc`, `package.json` publish metadata (`repository`, `homepage`, `bugs`, `keywords`, `publishConfig`, `prepublishOnly`, `prepack`).
- Dev: `Makefile` with host-agnostic CI goals — `make verify` runs install / build / typecheck / test / pack-check / smoke / audit in one shot.
- Docs: README synced with shipped v0.1.1 surface and the new Makefile workflow.

## [0.1.1] - 2026-04-23

- Per-source `syncPolicy`: `pinned` | `latest`, settable globally in `ccpp.config.json` and overridable per source entry.
- `--prefer-latest` and `--pinned` one-shot CLI overrides on `ccpp sync` (mutually exclusive; `--update` is kept as a documented alias for `--prefer-latest`).
- `autoAccept` config flag and `--auto-accept` CLI flag for silent apply — pair with `syncPolicy: latest` + the SessionStart hook to get a hands-off auto-update flow.
- One-time acknowledgement prompt when enabling `syncPolicy: latest` or `autoAccept: true`; acknowledgement timestamps persist in `ccpp.config.json` so the warning is shown only once per risk.
- Diff-preview before apply — each sync prints an added / modified / removed summary and prompts `[y/N]`. Skipped when `autoAccept: true` or `--auto-accept` is passed.
- New `ccpp config get | set | reset | list` subcommand for managing the v0.1.1 config surface (including per-source policy via dotted-path keys, e.g. `sources.<url>.policy`).
- `ccpp install-hook` / `ccpp uninstall-hook` for Claude Code SessionStart integration — registers/removes an entry in `~/.claude/settings.json` that auto-runs `ccpp sync` at session start.
- `ccpp status` command for runtime visibility: per-source policy, last-sync timestamp, skipped sources, recent failures.
- Structured sync log at `~/.ccpp/sync.log` (NDJSON, auto-rotated at ~1MB) capturing every hook-triggered and manual sync for debugging.

## [0.1.0] - Unreleased

- Initial release.
- Manifest parser supporting `.claude-plugin/marketplace.json` with convention-over-config fallback for repos that ship `plugins/<name>/.claude-plugin/plugin.json` and top-level `commands/*.md`.
- System-`git` delegation for source clone/sync — works with Bitbucket, GitLab, GitHub, and self-hosted git hosts via whatever auth the developer already has configured.
- Lockfile pinning (`ccpp.lock`) and diff-based incremental sync so teammates get byte-identical installs.
- Collision detection with explicit `--prefer <source>` resolution when two sources supply the same short command or skill name.
- Five CLI subcommands: `init`, `install`, `sync`, `list`, `uninstall`.
- Native Claude Code live-reload via auto-discovery paths — no `/reload-plugins` or restart required after `ccpp sync`.

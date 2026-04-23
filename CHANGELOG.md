# Changelog

All notable changes to this project will be documented in this file.

## [0.1.4] - 2026-04-23

- Fix: install wizard's post-install report now counts `installed + updated + unchanged` files, not just newly-created ones. Re-running the wizard over already-populated `~/.claude/` previously showed "0 command(s), 0 skill(s)" even though `ccpp list` correctly saw the full set. Report also now carries a 3-way breakdown line under the total.
- Library: counting logic extracted into pure `summarizeInstalledTargets()` in `src/commands/install-wizard.ts` and pinned by a named regression test plus shape tests.
- Docs: scrubbed all Omniconvert references from public-facing files — README, `docs/exit-codes.md`, `docs/auto-update.md`, test URL fixtures. Test author-name fixtures renamed to "Example Org AI Tooling". `MIGRATION.md` deleted (Omniconvert-specific guide, no generic content to salvage).

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

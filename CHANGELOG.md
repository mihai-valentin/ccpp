# Changelog

All notable changes to this project will be documented in this file.

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

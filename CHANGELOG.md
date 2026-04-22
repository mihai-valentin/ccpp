# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - Unreleased

- Initial release.
- Manifest parser supporting `.claude-plugin/marketplace.json` with convention-over-config fallback for repos that ship `plugins/<name>/.claude-plugin/plugin.json` and top-level `commands/*.md`.
- System-`git` delegation for source clone/sync — works with Bitbucket, GitLab, GitHub, and self-hosted git hosts via whatever auth the developer already has configured.
- Lockfile pinning (`ccpp.lock`) and diff-based incremental sync so teammates get byte-identical installs.
- Collision detection with explicit `--prefer <source>` resolution when two sources supply the same short command or skill name.
- Five CLI subcommands: `init`, `install`, `sync`, `list`, `uninstall`.
- Native Claude Code live-reload via auto-discovery paths — no `/reload-plugins` or restart required after `ccpp sync`.

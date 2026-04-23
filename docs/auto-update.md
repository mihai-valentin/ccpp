# Auto-update — three trust dimensions

`ccpp` v0.1.1 ships auto-update as **three independent switches**, not one. Each switch represents a distinct trust decision, and the combination of the three is what produces a given runtime behaviour. Flip them deliberately.

| Switch | Lives in | Risk it delegates |
|--------|----------|-------------------|
| **Sync policy** (`syncPolicy: pinned \| latest`) | `ccpp.config.json`; overridable per source | *Do I trust upstream to ship code to my machine?* With `latest`, any commit pushed to the source lands on the next sync. |
| **Auto-accept** (`autoAccept: true`) | `ccpp.config.json` (global only) | *Do I trust ccpp to apply changes without showing me a diff first?* With `true`, the diff-preview confirmation step is skipped. |
| **SessionStart hook** (`ccpp install-hook`) | `~/.claude/settings.json` | *Do I trust a sync to run every time Claude Code starts?* The hook makes sync non-interactive; hooks can't prompt. |

Keeping them separate is intentional. A lot of failure modes fall out cleanly when the three concerns can be toggled independently — "I want auto-update for one team repo but not for public plugins", "I want the hook but with interactive review", "I trust upstream but want to see the diff before apply", and so on.

## The combinations

| Policy | autoAccept | Hook | Behaviour |
|--------|:----------:|:----:|-----------|
| `pinned` | `false` | — | Default. `ccpp sync` re-installs the lockfile SHA; `sync --prefer-latest` is the only way upstream changes land. Diff preview shown on any change. |
| `pinned` | `true` | — | Lockfile still authoritative. `sync --prefer-latest` applies silently (no diff-preview). Good for scripted rollouts you've already reviewed. |
| `latest` | `false` | — | `ccpp sync` follows upstream HEAD but **prompts `[y/N]` before applying** the diff. Hook runs will *skip* these sources (see note below). |
| `latest` | `true` | — | `ccpp sync` follows upstream HEAD and applies silently. Without the hook you still need to trigger sync yourself (e.g. via a shell alias, a git post-checkout hook). |
| `latest` | `true` | installed | The "hands-off" setup. A new Claude Code session = fresh upstream content in `~/.claude/`. Intended endpoint for Omniconvert's day-two flow. |
| any | `false` | installed | Hook runs, fetches the source, but *does not apply* any change — applying requires either `autoAccept: true` or an interactive prompt, and hooks are non-interactive. The skip is logged to `~/.ccpp/sync.log` with a hint to run `ccpp sync` manually. |

The last row is the most important one to grok: installing the hook does **not** silently opt you in to auto-apply. You need `autoAccept: true` for that. The hook alone just guarantees a sync *attempts* to run at session start.

## Per-source overrides

The policy switch is the only one of the three that can be set per source. This is deliberate — `autoAccept` is a blanket "do I want to see diffs" preference, and the hook is a system-level registration. But you can reasonably want `latest` for your own team's repo and `pinned` for a third-party public plugin you've vetted at a specific SHA.

```json
{
  "version": 1,
  "scope": "user",
  "syncPolicy": "pinned",
  "autoAccept": true,
  "sources": [
    { "url": "git@bitbucket.org:mktz/ai-plugins-dev.git", "policy": "latest" },
    { "url": "https://github.com/example/community-tools.git" }
  ]
}
```

The CLI equivalent:

```bash
ccpp config set sources.git@bitbucket.org:mktz/ai-plugins-dev.git.policy latest
```

## One-time acknowledgements

Both `syncPolicy: latest` and `autoAccept: true` trigger a one-time warning + `[y/N]` prompt on first enable. On confirm, a timestamp (`policyAcknowledgedAt` / `autoAcceptAcknowledgedAt`) lands in `ccpp.config.json` and the warning is not shown again — even if you toggle the value off and back on later.

That design is load-bearing: the acknowledgement records *you've seen the risk*, not that the setting is currently enabled. Resetting the setting does not erase the acknowledgement; if you want to force yourself to re-see the warning, `ccpp config reset policyAcknowledgedAt` (or `autoAcceptAcknowledgedAt`) does that explicitly.

For scripted setup, `--auto-accept` on the `ccpp config set` call skips the prompt and records the acknowledgement as if you'd confirmed:

```bash
ccpp config set syncPolicy latest --auto-accept
ccpp config set autoAccept true --auto-accept
```

In a non-TTY shell (e.g. CI), omitting `--auto-accept` fails with exit `1` and a clear message — ccpp refuses to silently skip a warning you were supposed to see.

## Observability

Two surfaces tell you what auto-update has been doing:

- **`ccpp status`** — point-in-time view: per source, the last-sync timestamp, the effective policy, and any skips/errors from the most recent run. Run this after any session where you expected an upstream change to land and it didn't.
- **`~/.ccpp/sync.log`** — NDJSON history, auto-rotated at ~1MB. Every manual and hook-triggered sync writes one line. Grep-friendly: `grep '"skipped"' ~/.ccpp/sync.log` surfaces every source the hook declined to apply.

The hook never prints to a terminal (sessions shouldn't be noisy) and never blocks Claude Code on a failure — if the sync errors, the log records it and the session proceeds with whatever `~/.claude/` already had.

## Rolling back

Every one of the three switches is reversible without data loss:

```bash
ccpp uninstall-hook                    # removes the SessionStart entry
ccpp config set syncPolicy pinned      # resume lockfile-authoritative sync
ccpp config set autoAccept false       # restore the diff-preview prompt
```

`~/.claude/` state is unchanged — the switches only affect *future* syncs. Per-file `.bak.<timestamp>` backups from any prior apply are still on disk if you want to undo specific writes.

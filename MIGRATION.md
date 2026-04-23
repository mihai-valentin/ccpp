# Migrating from `ai-plugins-dev/install.sh` to `ccpp`

This guide is for Omniconvert engineers currently using the `ai-plugins-dev` private repo directly — i.e. `git clone ai-plugins-dev && ./install.sh`. It walks through swapping that flow for `ccpp install` + `ccpp sync`.

## Why we're switching

Same skills, same slash commands, same Bitbucket repo — but with auto-update, lockfile pinning, and no more manual `git pull && ./install.sh` dance. `ccpp` watches the repo for new commits, resolves them to a pinned SHA in `ccpp.lock`, and writes the content straight into Claude Code's auto-discovery paths. Short command names (`/git-commit`, `/pr-review`) are preserved; teammates get byte-identical installs because the lockfile pins the commit.

## What changes for you

| Old (`install.sh`)                                          | New (`ccpp`)                                               |
|-------------------------------------------------------------|------------------------------------------------------------|
| `git clone git@bitbucket.org:mktz/ai-plugins-dev.git`       | `npx ccpp install git@bitbucket.org:mktz/ai-plugins-dev.git` |
| `cd ai-plugins-dev && ./install.sh`                         | (the `install` command does this in one step)              |
| `git pull && ./install.sh` (to update)                      | `npx ccpp sync --update`                                   |
| Reading `install.sh` to know what got written where         | `npx ccpp list`                                            |
| Manually removing files from `~/.claude/` to uninstall      | `npx ccpp uninstall ai-plugins-dev`                        |
| Restart Claude Code / run `/reload-plugins` after updates   | No action — live-reload via native auto-discovery          |

## What stays the same

- **Short command names.** `/git-commit` stays `/git-commit`. No namespacing, no prefixes.
- **Skill content.** Every skill and command ships exactly as it does today. ccpp is a transport, not a rewriter.
- **Your Bitbucket SSH access.** ccpp shells out to the system `git` binary, so it inherits your existing SSH agent, `ssh-add`'d keys, and any `~/.ssh/config` host aliases. ccpp never sees or stores a credential.
- **The `ai-plugins-dev` repo itself.** It remains the source of truth. You can keep committing skills and commands to it the same way.

## Step-by-step migration

1. **Install ccpp globally** (once per machine):
   ```bash
   npm i -g ccpp
   # or use npx on every invocation if you prefer no global install
   ```

2. **Install `ai-plugins-dev` via ccpp:**
   ```bash
   npx ccpp install git@bitbucket.org:mktz/ai-plugins-dev.git
   ```
   ccpp clones into `~/.ccpp/cache/bitbucket.org/mktz/ai-plugins-dev/`, resolves HEAD, writes skills + commands into your Claude Code auto-discovery paths, and records the pinned commit in `ccpp.lock`.

3. **Verify** with `list`:
   ```bash
   npx ccpp list
   ```
   You should see every plugin and standalone command that `install.sh` used to write. Try any command in Claude Code (e.g. `/git-commit`) — it should respond exactly as before.

4. **(Optional) Remove the old install.sh-managed files.** ccpp writes to the same auto-discovery paths that `install.sh` did, so the old files have already been superseded in most cases. If you want to be thorough, grep for files that were written by `install.sh` but are no longer in the repo — those are orphans you can delete. ccpp's `sync` has its own orphan-detection once Wave 4 ships; until then this step is manual.

5. **(Optional) Auto-sync on session start.** Available from v0.1.1 — see [Moving from manual sync to auto-update (v0.1.1+)](#moving-from-manual-sync-to-auto-update-v011) below.

## Moving from manual sync to auto-update (v0.1.1+)

This is the successor to the v0.1.0 beachhead: `ccpp sync` auto-runs at Claude Code session start, fetches any new commits from upstream, and applies them without you lifting a finger. That's exactly the gap `install.sh` left open — the CTO pushes a new command to `ai-plugins-dev`, and every teammate has to remember to re-sync. This flow closes it.

You'll flip **three independent switches**. Each one has a distinct risk; take a moment to read the trust-model notes in [README — Auto-update via SessionStart hook](./README.md#auto-update-via-sessionstart-hook) before you turn them all on.

1. **Opt sources in to `latest` policy.** By default ccpp stays on the SHA recorded in `ccpp.lock`. Switching to `latest` means any commit pushed to a source lands on your next sync.
   ```bash
   ccpp config set syncPolicy latest --auto-accept
   ```
   The `--auto-accept` flag acknowledges the one-time policy-risk warning in-line, for scripted setup. Omit it if you want to see the prompt and respond interactively.

2. **Enable silent apply.** With `autoAccept: true`, ccpp applies the diff without prompting — the hook needs this because hooks are non-interactive.
   ```bash
   ccpp config set autoAccept true --auto-accept
   ```
   This is a *separate* acknowledgement from step 1. You're opting out of the diff-preview guard for manual syncs, too — re-enable it any time with `ccpp config reset autoAccept` + `ccpp config reset autoAcceptAcknowledgedAt`.

3. **Register the SessionStart hook.**
   ```bash
   ccpp install-hook
   ```
   This writes an entry into `~/.claude/settings.json` that runs `ccpp sync` whenever Claude Code starts a new session. The hook is defensive: sync errors log to `~/.ccpp/sync.log` and never block Claude Code from starting.

4. **Verify.** Open a fresh Claude Code session, then:
   ```bash
   ccpp status
   ```
   You should see each source with a recent `last-sync` timestamp and a `policy=latest` label. Ask the CTO to push a test commit to `ai-plugins-dev`, start a new Claude Code session, and re-run `ccpp status` — the SHA should advance with no manual intervention.

### Rollback the auto-update flow

If auto-update misbehaves on a given machine, step back out safely:

```bash
ccpp uninstall-hook                          # removes the SessionStart entry
ccpp config set syncPolicy pinned            # stop following upstream automatically
ccpp config set autoAccept false             # restore the diff-preview confirmation
```

The acknowledgement timestamps stay in place — they're a record that you've *seen* the warnings, not a live setting. If you later re-enable either flag, ccpp won't re-prompt.

## Rollback

ccpp writes `.bak.<timestamp>` backups next to any file it replaces. If something in the migrated install misbehaves, restore the backups and re-run the old `install.sh`:

```bash
# example — restore every ccpp backup in a directory
find ~/.claude -name '*.bak.*' -print
# then move them back over the files ccpp wrote, and ./install.sh as before
```

Report rollbacks to the owning engineer — if something broke, we want the signal before more teams hit it.

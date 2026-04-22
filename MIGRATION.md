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

5. **(Optional) Auto-sync on session start.** Once Wave 5 ships, you'll be able to add a Claude Code SessionStart hook that runs `ccpp sync` automatically. This keeps every session current without any manual step. Instructions will land in this file when that release is cut.

## Rollback

ccpp writes `.bak.<timestamp>` backups next to any file it replaces. If something in the migrated install misbehaves, restore the backups and re-run the old `install.sh`:

```bash
# example — restore every ccpp backup in a directory
find ~/.claude -name '*.bak.*' -print
# then move them back over the files ccpp wrote, and ./install.sh as before
```

Report rollbacks to the owning engineer — if something broke, we want the signal before more teams hit it.

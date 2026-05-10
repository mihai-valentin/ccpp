# ccpp exit codes

Every ccpp subcommand exits with one of the codes below. Scripts driving ccpp (CI, pre-commit hooks, SessionStart hooks) can switch on the code to decide what to do next.

| Code | Meaning | Typical trigger |
|-----:|---------|-----------------|
| `0` | Success | The command completed; nothing to report. |
| `1` | User error | The command was invoked incorrectly or pointed at bad inputs — unknown flag, missing required argument, a `ccpp.config.json` / `ccpp.lock.json` that failed schema validation, or a refusal to overwrite without `--force`. Message printed to stderr. |
| `2` | Environment error | An operation failed at runtime — a git fetch couldn't reach the remote, a manifest file couldn't be parsed, a disk write was denied, a pinned SHA couldn't be checked out. Message printed to stderr with the underlying `git` / filesystem error. |
| `3` | Collision requiring user input | Two or more sources supply the same short command or skill name and ccpp needs a `--prefer <source>` choice (or `preferredSources` entry in `ccpp.config.json`) before it can write anything. |

## Examples

### `0` — clean sync

```bash
$ ccpp sync --auto-accept
✓ git@bitbucket.org:your-org/ai-plugins.git  policy=latest  SHA: 9f3c2a1 -> 9f3c2a1  (0 added, 0 modified, 0 removed) (up-to-date)
$ echo $?
0
```

### `1` — no URL in a non-interactive context

`ccpp install` with no URL launches the first-time setup wizard on a TTY. In a non-interactive context (CI, piped stdin, `--quiet`), or when `ccpp.config.json` already exists, the wizard refuses and exits 1 with a pointer at the non-interactive form:

```bash
$ ccpp install < /dev/null
✗ ccpp install: no <url> provided and stdin is not a TTY. Pass a URL: `ccpp install <url>`.
$ echo $?
1
```

### `1` — invalid config

```bash
$ ccpp sync
✗ Invalid config /path/to/ccpp.config.json: "sources" must be an array.
$ echo $?
1
```

### `2` — git fetch failure

```bash
$ ccpp sync --auto-accept
✗ git@bitbucket.org:your-org/ai-plugins.git: git fetch --tags --prune origin failed (exit 128): fatal: could not read from remote repository.
  Please make sure you have the correct access rights and the repository exists.
$ echo $?
2
```

### `3` — collision (non-interactive only)

When two sources supply the same short command or skill name, ccpp's behaviour splits on interactivity:

- **On a TTY:** ccpp prompts per-collision (`keep` / `use-incoming` / `cancel`) and records the winner under `preferredSources` in `ccpp.config.json`. Exits 0 on successful resolution, 1 on `cancel`.
- **In a non-interactive context** (scripts, CI, piped stdin, `--quiet`): ccpp refuses and exits `3` so the caller can fail loudly. Resolve by pre-declaring the winner via `--prefer`, or by adding `preferredSources` to `ccpp.config.json` ahead of time.

```bash
$ ccpp install https://github.com/example/overlap.git < /dev/null
✗ 1 collision(s) unresolved:
  git-commit: git@bitbucket.org:your-org/ai-plugins.git vs https://github.com/example/overlap.git
Resolve with: ccpp install https://github.com/example/overlap.git --prefer   # makes this install win
$ echo $?
3
```

## Hook context

The SessionStart hook script installed by `ccpp install-hook` **always exits 0** regardless of what happens inside it — non-zero exits from `ccpp sync` would block Claude Code from starting, which is never the right tradeoff. Failures during a hook-triggered sync are captured to `~/.ccpp/sync.log` and surfaced the next time you run `ccpp status`. Treat `ccpp status` as the authoritative signal in that context, not the hook's exit code.

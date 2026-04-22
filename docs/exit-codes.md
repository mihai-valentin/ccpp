# ccpp exit codes

Every ccpp subcommand exits with one of the codes below. Scripts driving ccpp (CI, pre-commit hooks, SessionStart hooks) can switch on the code to decide what to do next.

| Code | Meaning | Typical trigger |
|-----:|---------|-----------------|
| `0` | Success | The command completed; nothing to report. |
| `1` | Runtime error | An operation failed at runtime — a git fetch couldn't reach the remote, a manifest file couldn't be read, a disk write was denied. Message printed to stderr. |
| `2` | Usage error | The command was invoked incorrectly — unknown flag, missing required argument, or a `ccpp.json` / `ccpp.lock` that failed schema validation. |
| `3` | Collision requiring user input | Two or more sources supply the same short command or skill name and ccpp needs a `--prefer <source>` choice from you before it can write anything. |

## Examples

### `0` — clean sync

```bash
$ npx ccpp sync
Syncing 2 source(s)…
✓ ai-plugins-dev@9f3c2a1 (no changes)
✓ public-tools@7e1bbee (1 command updated)
$ echo $?
0
```

### `1` — git fetch failure

```bash
$ npx ccpp sync
Syncing 1 source(s)…
✗ ai-plugins-dev: git fetch failed
  git fetch --tags --prune origin failed (exit 128): fatal: could not read from remote repository.
  Please make sure you have the correct access rights and the repository exists.
$ echo $?
1
```

### `2` — invalid manifest

```bash
$ npx ccpp sync
ccpp.json: "sources" must be a non-empty object
$ echo $?
2
```

### `3` — collision

```bash
$ npx ccpp install https://github.com/example/overlap.git
Error: command "/git-commit" is already provided by "ai-plugins-dev".
Re-run with --prefer <source> to record a preference and proceed.
$ echo $?
3
```

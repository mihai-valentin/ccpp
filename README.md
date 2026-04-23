# ccpp — Claude Code Plugin Proxy

Private skill / slash-command distribution for Claude Code teams. Syncs resources from private git repos (Bitbucket, GitLab, GitHub, self-hosted) into `~/.claude/` — preserving **short command names**, using **native live-reload**, and working with whatever git auth the dev already has.

Installable via npm; daily invocation via `npx ccpp sync`.

Part of the [xlnf](../) portfolio. See [`idea.md`](./idea.md) for target users, pain, feature scope, pricing, success metric, and open questions.

> Name note: `ccpp` (Claude Code Plugin Proxy) is a working slug and will likely be renamed before public release. The npm package name is decided at that point — see open questions in `idea.md`.

## Install

```bash
# Global install — once per machine
npm i -g ccpp

# Or ad-hoc via npx — no install required
npx ccpp --help
```

Requirements:

- Node.js ≥ 20
- A working `git` on your `$PATH` (ccpp delegates auth to whatever you already have configured — SSH agent, credential helper, `gh auth login`)

## Quick Start

### Fastest path — interactive wizard (first-time only)

In a fresh working directory, run `ccpp install` with no URL. On a TTY, this launches the first-time setup wizard: it asks for your source URL, sync policy (`pinned`/`latest`), whether to enable `autoAccept`, and whether to install the Claude Code SessionStart hook — then writes `ccpp.config.json`, clones the source, installs its content into `~/.claude/`, registers the hook if requested, and prints a report plus "what's next" guide.

```bash
mkdir my-ccpp && cd my-ccpp
npx ccpp install
```

The wizard only runs on the very first invocation (no `ccpp.config.json` yet). Once you've got one, add further sources with the explicit form below.

### Explicit form — always available, scriptable

```bash
# 1. Create ccpp.config.json (non-interactive — no prompts, no plan preview)
npx ccpp init

# 2. Install one or more source repos (private or public)
npx ccpp install git@bitbucket.org:your-org/ai-plugins.git
npx ccpp install https://github.com/your-org/claude-plugins.git

# 3. Later — sync all sources to the commit pinned in ccpp.lock.json (with a diff-preview prompt)
npx ccpp sync

# 4. See what's installed
npx ccpp list

# 5. Remove a source
npx ccpp uninstall ai-plugins
```

## How it works

ccpp reads each source's `.claude-plugin/marketplace.json` — the same manifest shape Claude Code already uses — and, when that file is missing, falls back to a convention scan: any directory under `plugins/<name>/` with a `.claude-plugin/plugin.json` is a plugin, and any `commands/*.md` at the repo root is a standalone slash command. This means existing private repos that pre-date the marketplace format work without authoring a manifest first.

Content is written into Claude Code's native auto-discovery paths under `~/.claude/`. That means Claude Code picks up changes on its own — no `/reload-plugins` or restart required. Short command names (e.g. `/git-commit`) are preserved; ccpp does **not** rewrite them to namespaced forms.

Every `ccpp install` and `ccpp sync` updates `ccpp.lock.json`, pinning each source to the exact commit SHA that was materialised on disk. The lockfile is what makes teammate installs byte-identical. What governs *when* upstream changes land — and whether you see a diff-preview prompt before they do — is the per-source `syncPolicy` plus `autoAccept` flag, both introduced in v0.1.1 and documented in the [Sync policy](#sync-policy) and [Auto-update](#auto-update-via-sessionstart-hook) sections below. By default (`syncPolicy: pinned`, `autoAccept: false`), every `ccpp sync` shows you an added / modified / removed summary and asks `[y/N]` before touching `~/.claude/`.

## Sync policy

ccpp v0.1.1 introduces a **per-source sync policy** so you can choose, per source, whether `ccpp sync` should stay at the pinned commit or fast-forward to the latest upstream HEAD.

| Policy | Behaviour on `ccpp sync` |
|--------|--------------------------|
| `pinned` *(default)* | Resolve the commit recorded in `ccpp.lock.json`. Upstream changes require an explicit `ccpp sync --prefer-latest` to land. Safe default — teammates never get surprised by a silent upstream bump. |
| `latest` | Fetch the configured ref's current tip, apply it, and advance the lockfile. Pair with `autoAccept: true` + the SessionStart hook to get a true auto-update experience. |

Set the global policy and per-source overrides via `ccpp config`:

```bash
# Opt the whole project into latest (one-time confirmation prompt — see 'Auto-update' below)
ccpp config set syncPolicy latest

# Or opt in per-source, leaving the rest pinned
ccpp config set sources.git@bitbucket.org:your-org/ai-plugins.git.policy latest
```

A minimal `ccpp.config.json` that mixes both shapes:

```json
{
  "version": 1,
  "scope": "user",
  "syncPolicy": "pinned",
  "sources": [
    { "url": "git@bitbucket.org:your-org/ai-plugins.git" },
    { "url": "git@bitbucket.org:your-org/experimental.git", "policy": "latest" }
  ]
}
```

Two one-shot CLI overrides ignore the configured policy for a single invocation without persisting anything:

```bash
ccpp sync --prefer-latest   # treat every source as policy=latest for this run
ccpp sync --pinned          # treat every source as policy=pinned for this run
```

`--prefer-latest` and `--pinned` are mutually exclusive. `--update` is kept as a documented alias for `--prefer-latest` so existing scripts keep working.

## Auto-update via SessionStart hook

Pair `syncPolicy: latest` + `autoAccept: true` + a Claude Code SessionStart hook to get upstream changes applied automatically at the start of every Claude Code session — no manual `ccpp sync`, no `/reload-plugins`.

```bash
# 1. Opt in to latest (one-time policy-risk warning)
ccpp config set syncPolicy latest

# 2. Opt in to silent apply (one-time auto-accept warning — separate risk)
ccpp config set autoAccept true

# 3. Register the SessionStart hook in ~/.claude/settings.json
ccpp install-hook

# 4. Confirm
ccpp status
```

### Trust model — what you're opting in to

The two flags are deliberately separate because they represent different risks, and you should acknowledge them independently:

- **`syncPolicy: latest`** — any commit pushed to a source (including from compromised accounts, leaked credentials, or former-contributor access) will land in your `~/.claude/` on the next sync. You trust upstream.
- **`autoAccept: true`** — ccpp applies changes without asking you to review them first. You lose the diff-preview confirmation step.

Enabling either value for the first time prints a warning describing the risk and prompts `[y/N]`. On confirm, a timestamp (`policyAcknowledgedAt` / `autoAcceptAcknowledgedAt`) lands in `ccpp.config.json` and the warning is not shown again. Use `--auto-accept` on the `ccpp config set` call to skip the prompt in scripted setup — it still records the acknowledgement so the decision is auditable.

### Hook semantics

The hook is intentionally defensive:

- **Never blocks Claude Code.** Sync errors (offline, auth failure, network blip) are logged to `~/.ccpp/sync.log` and the hook exits 0 — Claude Code proceeds with whatever state `~/.claude/` already has.
- **No prompts inside the hook.** Hooks are non-interactive. A source with `policy: latest` but `autoAccept: false` is *skipped* during a hook-triggered sync (with a log line) — you still need to run `ccpp sync` manually to review that source.
- **Fast.** Hook start-up adds <500ms on a cache-hit happy path.

### What `ccpp status` shows

```
$ ccpp status
SOURCE                                          POLICY  LAST_SYNC                 SHA      STATUS
git@bitbucket.org:your-org/ai-plugins.git       latest  2026-04-23T09:12:04.000Z  9f3c2a1  up-to-date
git@bitbucket.org:your-org/experimental.git         latest  2026-04-23T09:12:04.000Z  —        skipped (autoAccept=false or user-declined)
https://github.com/anthropic/community-tools    pinned  2026-04-21T14:00:12.000Z  8e01c3d  up-to-date

Recent events:
  ✓ 2026-04-23T09:12:04.000Z  hook  git@.../ai-plugins.git      +1/~0/-0
  ! 2026-04-23T09:12:04.000Z  hook  git@.../experimental.git        +2/~0/-0
  ✓ 2026-04-21T14:00:12.000Z  manual  https://.../community-tools   +0/~0/-0
```

Per-source state (policy, last-sync timestamp, pinned SHA, current status) and the tail of the log. `~/.ccpp/sync.log` (NDJSON, auto-rotated at ~1MB) has the full history if you need to dig in. Run `ccpp status --json` for a machine-readable report.

For a deeper walkthrough of the three trust dimensions, see [`docs/auto-update.md`](./docs/auto-update.md).

## Common recipes

### Single-source team setup

One shared Bitbucket/GitLab repo of in-house skills. Each teammate runs:

```bash
npx ccpp install git@bitbucket.org:your-org/ai-plugins.git
```

…and `npx ccpp sync` after each `git pull` of the manifest-owning repo.

### Multi-source setup

Combine an in-house repo with a public one. `ccpp.config.json` holds both; `ccpp sync` resolves all of them in one pass.

```bash
npx ccpp install git@bitbucket.org:your-org/internal.git
npx ccpp install https://github.com/anthropic-labs/claude-code-tools.git
npx ccpp sync
```

### Ad-hoc one-off install

Try a public plugin repo without committing it to the project manifest:

```bash
npx ccpp install https://github.com/example/some-plugin.git --scratch
```

`--scratch` materialises into a throw-away sandbox under `~/.ccpp/scratch/` and never touches `ccpp.config.json` / `ccpp.lock.json`.

## Troubleshooting

### Auth failures

ccpp never handles tokens — it delegates to `git`. A non-interactive failure means `git` itself couldn't authenticate.

- For SSH URLs: confirm `ssh -T git@<host>` works and that `ssh-add -l` lists the key you expect.
- For HTTPS URLs: confirm `git credential-helper` is configured (`git config --get credential.helper`), or log in with `gh auth login` for GitHub repos.
- The error ccpp shows on failure includes the raw stderr from `git` — read it; it will tell you exactly what git tried and why it failed.

### Collision resolution

If two sources both define `/git-commit`:

- **On a TTY (manual invocation):** ccpp prompts you per-conflict — keep existing, accept incoming, or cancel. The chosen winner is recorded in `ccpp.config.json` under `preferredSources` so subsequent syncs stay deterministic.
- **In a non-interactive context (CI, piped stdin, `--quiet`):** ccpp refuses the install and exits with code `3`. Pre-declare the winner to avoid the prompt:

```bash
npx ccpp install <url> --prefer
```

`--prefer` means "every collision this install produces resolves in this source's favour."

### Cache reset

ccpp caches source clones under `${CCPP_CACHE:-~/.ccpp/cache}`. Nuke it if something seems wedged:

```bash
rm -rf ~/.ccpp/cache
npx ccpp sync
```

### Hook not firing

If you ran `ccpp install-hook` but a new Claude Code session doesn't seem to be picking up upstream changes, walk these three checkpoints in order:

1. **Is the hook registered?** Open `~/.claude/settings.json` and look for a `SessionStart` entry pointing at `ccpp sync`. If it's missing, the install step didn't land (a permissions issue on the file, or it was removed by another tool) — re-run `ccpp install-hook`.
2. **Did the hook run and silently fail?** Tail `~/.ccpp/sync.log` — every hook-triggered sync writes an NDJSON line, success or failure. Auth failures, offline remotes, and sources skipped for `autoAccept=false` all show up here.
3. **What does ccpp think happened?** `ccpp status` renders the last-sync state per source and flags any skips / errors from the last hook pass. If status says everything succeeded but you're not seeing the upstream change, check that `syncPolicy` really is `latest` for that source (`ccpp config get sources.<url>.policy`).

See [`docs/exit-codes.md`](./docs/exit-codes.md) for the full exit-code reference.

## Development

Everything a contributor or CI pipeline needs is exposed through `make`:

```bash
make help          # list all targets with one-line docs
make ci            # install + build + typecheck + test + pack-check
make verify        # ci + bash smoke test + npm audit (the full local gate)
make smoke         # build + scripts/smoke.sh (end-to-end against a local git fixture)
make pack-check    # npm pack --dry-run — confirms the published tarball shape
make release-dry   # verify + npm publish --dry-run (rehearsal, no upload)
make release       # verify + publish (refuses on a dirty tree or placeholder URL)
```

`make ci` is the single command a CI runner (GitHub Actions, Bitbucket Pipelines, self-hosted) needs to invoke on every push. Under `CI=1` it uses `npm ci` for lockfile-reproducible installs; locally it uses `npm install`. The `lint` target runs `biome check` but is deliberately **not** in the CI gate — the codebase has some existing style-advisory drift (`noNonNullAssertion`, `useLiteralKeys`) that will be cleaned up separately.

Fresh-clone bootstrap:

```bash
git clone <remote-url> ccpp
cd ccpp
make install
make verify
```

Test layout — unit tests live next to the source (`src/**/*.test.ts`) and CLI / end-to-end tests in `tests/` (including `tests/integration/` for bare-git-fixture-driven flows). All 158 tests should run in under 10 seconds.

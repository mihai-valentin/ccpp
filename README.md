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

```bash
# 1. In your working directory (or a fresh one), create a ccpp.json manifest
npx ccpp init

# 2. Install one or more source repos (private or public)
npx ccpp install git@bitbucket.org:your-org/ai-plugins-dev.git
npx ccpp install https://github.com/your-org/claude-plugins.git

# 3. Later — sync all sources to their latest HEAD (or the pinned commit in ccpp.lock)
npx ccpp sync

# 4. See what's installed
npx ccpp list

# 5. Remove a source
npx ccpp uninstall ai-plugins-dev
```

## How it works

ccpp reads each source's `.claude-plugin/marketplace.json` — the same manifest shape Claude Code already uses — and, when that file is missing, falls back to a convention scan: any directory under `plugins/<name>/` with a `.claude-plugin/plugin.json` is a plugin, and any `commands/*.md` at the repo root is a standalone slash command. This means existing repos like Omniconvert's `ai-plugins-dev` work without authoring a marketplace manifest.

Content is written into Claude Code's native auto-discovery paths under `~/.claude/`. That means Claude Code picks up changes on its own — no `/reload-plugins` or restart required. Short command names (e.g. `/git-commit`) are preserved; ccpp does **not** rewrite them to namespaced forms.

Every `ccpp install` and `ccpp sync` updates `ccpp.lock`, pinning each source to the exact commit SHA that was materialised on disk. Re-running `ccpp sync` without `--update` installs the pinned commits; with `--update` it fetches newer HEADs and rewrites the lock. That means teammates checking out the repo get byte-identical skill/command content.

## Common recipes

### Single-source team setup

One shared Bitbucket/GitLab repo of in-house skills. Each teammate runs:

```bash
npx ccpp install git@bitbucket.org:your-org/ai-plugins-dev.git
```

…and `npx ccpp sync` after each `git pull` of the manifest-owning repo.

### Multi-source setup

Combine an in-house repo with a public one. `ccpp.json` holds both; `ccpp sync` resolves all of them in one pass.

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

`--scratch` materialises into a throw-away sandbox under `~/.ccpp/scratch/` and never touches `ccpp.json` / `ccpp.lock`.

## Troubleshooting

### Auth failures

ccpp never handles tokens — it delegates to `git`. A non-interactive failure means `git` itself couldn't authenticate.

- For SSH URLs: confirm `ssh -T git@<host>` works and that `ssh-add -l` lists the key you expect.
- For HTTPS URLs: confirm `git credential-helper` is configured (`git config --get credential.helper`), or log in with `gh auth login` for GitHub repos.
- The error ccpp shows on failure includes the raw stderr from `git` — read it; it will tell you exactly what git tried and why it failed.

### Collision resolution

If two sources both define `/git-commit`, ccpp refuses the install and exits with code `3`. Resolve with:

```bash
npx ccpp install <url> --prefer <source-name>
```

…which records the preference in `ccpp.json` so subsequent syncs are deterministic.

### Cache reset

ccpp caches source clones under `${CCPP_CACHE:-~/.ccpp/cache}`. Nuke it if something seems wedged:

```bash
rm -rf ~/.ccpp/cache
npx ccpp sync
```

See [`docs/exit-codes.md`](./docs/exit-codes.md) for the full exit-code reference.

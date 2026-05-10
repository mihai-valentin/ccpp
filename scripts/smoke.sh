#!/usr/bin/env bash
#
# Minimal end-to-end smoke test for the compiled ccpp CLI.
# Human-runnable sanity check for release time — no vitest, no node_modules
# beyond what the compiled bundle already carries.
#
# Usage:  scripts/smoke.sh           # assumes dist/cli.cjs is built
#         scripts/smoke.sh --build   # builds first
#
# Exits 0 on success, non-zero on first failed step.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/dist/cli.cjs"

if [ "${1:-}" = "--build" ]; then
  ( cd "$ROOT" && npm run build >/dev/null )
fi

if [ ! -f "$CLI" ]; then
  echo "missing $CLI — run with --build or \`npm run build\` first" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SRC_BARE="$TMP/source.git"
SRC_WORK="$TMP/source-work"
CLAUDE_HOME="$TMP/claude"
PROJECT="$TMP/project"

export CCPP_CACHE="$TMP/cache"
# Pin user-scope config + lockfile into the scratch tree so this smoke test
# never touches the developer's real ~/.ccpp/. Required since v0.2.2's
# user-scope default — without this the `ccpp init` step would find the
# user's real config and refuse to overwrite.
export CCPP_HOME="$TMP/ccpp-home"
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
export NO_COLOR=1

mkdir -p "$SRC_BARE" "$SRC_WORK" "$CLAUDE_HOME" "$PROJECT"

say() { printf '\n=== %s ===\n' "$*"; }
ccpp() { node "$CLI" "$@" --claude-home "$CLAUDE_HOME"; }

# -------- 1. build a tiny source repo --------
say 'seed local bare git source'
git init --bare --initial-branch=main -q "$SRC_BARE"
git -C "$SRC_WORK" init --initial-branch=main -q
git -C "$SRC_WORK" config user.email smoke@example.com
git -C "$SRC_WORK" config user.name  Smoke
git -C "$SRC_WORK" config commit.gpgsign false

mkdir -p "$SRC_WORK/commands" \
         "$SRC_WORK/plugins/demo/.claude-plugin" \
         "$SRC_WORK/plugins/demo/commands" \
         "$SRC_WORK/plugins/demo/skills/greet"
echo '# hello command' > "$SRC_WORK/commands/hello.md"
echo '# demo-run'      > "$SRC_WORK/plugins/demo/commands/demo-run.md"
echo '# greet skill'   > "$SRC_WORK/plugins/demo/skills/greet/SKILL.md"
cat > "$SRC_WORK/plugins/demo/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "demo",
  "version": "0.1.0",
  "description": "Smoke-test demo plugin",
  "author": { "name": "Smoke" }
}
JSON

git -C "$SRC_WORK" add -A
git -C "$SRC_WORK" commit -m initial -q
git -C "$SRC_WORK" remote add origin "$SRC_BARE"
git -C "$SRC_WORK" push -u origin main -q
git -C "$SRC_BARE" symbolic-ref HEAD refs/heads/main

URL="file://$SRC_BARE"

# -------- 2. exercise the CLI --------
say 'help'
node "$CLI" --help | grep -q 'Exit codes:'

say 'init'
# --project forces the team-share path (./ccpp.config.json) instead of the
# v0.2.2 user-scope default. This smoke test exercises that workflow:
# config + lockfile committed alongside the project tree.
( cd "$PROJECT" && ccpp init --project --source "$URL" )
test -f "$PROJECT/ccpp.config.json"

say 'sync (fresh install)'
( cd "$PROJECT" && ccpp sync --auto-accept )
test -f "$CLAUDE_HOME/commands/hello.md"
test -f "$CLAUDE_HOME/commands/demo-run.md"
test -f "$CLAUDE_HOME/skills/greet/SKILL.md"
test -f "$PROJECT/ccpp.lock.json"

say 'list'
( cd "$PROJECT" && ccpp list ) | grep -q 'hello'

say 'sync (idempotent — expect all unchanged)'
before_mtime=$(stat -c %Y "$CLAUDE_HOME/commands/hello.md")
sleep 1
( cd "$PROJECT" && ccpp sync --auto-accept )
after_mtime=$(stat -c %Y "$CLAUDE_HOME/commands/hello.md")
if [ "$before_mtime" != "$after_mtime" ]; then
  echo "FAIL: hello.md mtime changed on idempotent sync" >&2
  exit 1
fi

say 'update flow — bump hello.md, resync, expect overwrite + .bak'
echo '# hello v2' > "$SRC_WORK/commands/hello.md"
git -C "$SRC_WORK" commit -am 'bump hello' -q
git -C "$SRC_WORK" push origin main -q
( cd "$PROJECT" && ccpp sync --auto-accept )
grep -q 'v2' "$CLAUDE_HOME/commands/hello.md"
ls "$CLAUDE_HOME/commands/"hello.md.bak.* >/dev/null

say 'uninstall'
( cd "$PROJECT" && ccpp uninstall "$URL" )
test ! -f "$CLAUDE_HOME/commands/hello.md"
test ! -f "$CLAUDE_HOME/skills/greet/SKILL.md"

say 'exit-code mapping — missing URL must exit 1'
set +e
node "$CLI" install >/dev/null 2>&1
code=$?
set -e
if [ "$code" -ne 1 ]; then
  echo "FAIL: expected exit 1 for missing URL, got $code" >&2
  exit 1
fi

echo
echo 'OK — ccpp smoke test passed'

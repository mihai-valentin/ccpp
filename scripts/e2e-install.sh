#!/usr/bin/env bash
#
# Real-installation end-to-end test for ccpp.
#
# Unlike scripts/smoke.sh (which runs `node dist/cli.cjs` directly against a
# local bare-git fixture), this script:
#
#   1. Packs ccpp from source via `npm pack` — same tarball that would ship
#      to the npm registry.
#   2. Installs that tarball into an isolated `node_modules/` via `npm install`,
#      exercising the bin-shim setup the user actually gets when they run
#      `npm install -g <release-tarball-url>` from a GitHub Release.
#   3. Runs the resulting `ccpp` binary against the real `ccpp-test-pingpong`
#      remote on GitHub (public repo, pulled over HTTPS — no auth needed).
#   4. Asserts the full lifecycle: install → list → sync → uninstall.
#
# Requires: network access to github.com and `node`/`npm` on PATH.
# Usage:    bash scripts/e2e-install.sh
# Or:       npm run test:e2e:install
#
# Exits 0 on success, non-zero on first failed step. Prints a clear
# skip-with-reason if the remote is unreachable.

set -euo pipefail

REMOTE="https://github.com/mihai-valentin/ccpp-test-pingpong.git"
TAG="v0.1.0"
BRANCH="add-cheer-agent"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Helpers
green="$(printf '\033[32m')"; red="$(printf '\033[31m')"; dim="$(printf '\033[2m')"; reset="$(printf '\033[0m')"
say()   { printf '\n=== %s ===\n' "$*"; }
pass()  { printf "${green}✓${reset} %s\n" "$1"; }
fail()  { printf "${red}✗${reset} %s\n" "$1" >&2; exit 1; }
info()  { printf "${dim}  %s${reset}\n" "$1"; }
jq_get() {
  # Read JSON from stdin, return a JS expression evaluated against it.
  # Avoids requiring `jq` — node is already a hard dependency for ccpp.
  node -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log('"$1"');'
}

# Probe the remote. If unreachable, skip with a clear reason rather than
# fail mysteriously — same UX as the vitest e2e suite.
if ! git ls-remote --exit-code --quiet "$REMOTE" refs/heads/master >/dev/null 2>&1; then
  echo
  echo "⚠ probe of $REMOTE failed — skipping e2e-install."
  echo "  Re-run with network access to github.com."
  exit 0
fi

# Set up scratch dirs. CCPP_HOME and CCPP_CACHE both point inside the
# scratch tree so the test never touches the user's real ~/.ccpp/ or
# ~/.claude/.
SCRATCH="$(mktemp -d -t ccpp-e2e-install-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

INSTALL_DIR="$SCRATCH/install"
CLAUDE_HOME="$SCRATCH/claude"
CCPP_HOME_DIR="$SCRATCH/ccpp-home"
CACHE="$SCRATCH/cache"
mkdir -p "$INSTALL_DIR" "$CLAUDE_HOME" "$CCPP_HOME_DIR" "$CACHE"

export CCPP_HOME="$CCPP_HOME_DIR"
export CCPP_CACHE="$CACHE"
export NO_COLOR=1
# Block git from prompting for credentials — the fixture is public over
# HTTPS, so any prompt would mean something's actually wrong.
export GIT_TERMINAL_PROMPT=0

# -------- 1. pack --------
say 'pack ccpp from source'
cd "$PROJECT_ROOT"
TARBALL_NAME="$(npm pack --silent --pack-destination "$SCRATCH" 2>/dev/null | tail -n1)"
TARBALL="$SCRATCH/$TARBALL_NAME"
[ -f "$TARBALL" ] || fail "tarball not produced at $TARBALL"
pass "tarball: $(basename "$TARBALL") ($(du -h "$TARBALL" | cut -f1))"

# -------- 2. install into an isolated node_modules --------
say 'install ccpp from the tarball into a clean node_modules'
cd "$INSTALL_DIR"
echo '{"name":"ccpp-e2e-install-host","private":true}' > package.json
npm install --no-save --silent "$TARBALL" >/dev/null
CCPP_BIN="$INSTALL_DIR/node_modules/.bin/ccpp"
[ -x "$CCPP_BIN" ] || fail "ccpp shim missing at $CCPP_BIN"
pass "shim installed at $CCPP_BIN"

# Sanity: --version reports the same string as package.json.
EXPECTED_VERSION="$(node -e 'console.log(require("'"$PROJECT_ROOT"'/package.json").version)')"
ACTUAL_VERSION="$("$CCPP_BIN" --version 2>&1 | grep -o "${EXPECTED_VERSION}" | head -1)"
if [ "$ACTUAL_VERSION" != "$EXPECTED_VERSION" ]; then
  "$CCPP_BIN" --version >&2
  fail "version mismatch — expected $EXPECTED_VERSION"
fi
pass "version: $EXPECTED_VERSION"

# Helper: run the installed ccpp shim with our scratch claude-home.
ccpp() { "$CCPP_BIN" --claude-home "$CLAUDE_HOME" "$@"; }

# -------- 3. install the ping-pong fixture from GitHub --------
say "ccpp install $REMOTE"
ccpp install "$REMOTE" --quiet || fail "ccpp install failed"
pass "install completed"

EXPECTED=(
  "$CLAUDE_HOME/commands/ping.md"
  "$CLAUDE_HOME/commands/pong.md"
  "$CLAUDE_HOME/skills/rally/SKILL.md"
  "$CLAUDE_HOME/skills/rally/references/strategies.md"
  "$CLAUDE_HOME/agents/referee.md"
)
for f in "${EXPECTED[@]}"; do
  [ -f "$f" ] || fail "expected file missing: $f"
  info "found $(basename "$f")"
done
pass "all 5 expected files materialized"

# Spot-check content — referee.md should mention the agent name in its frontmatter.
grep -q "^name: referee" "$CLAUDE_HOME/agents/referee.md" \
  || fail "agent frontmatter not preserved in referee.md"
pass "agent frontmatter preserved byte-for-byte"

# -------- 4. ccpp list --------
say 'ccpp list'
LIST_JSON="$(ccpp list --json)"
ROW_COUNT="$(echo "$LIST_JSON" | jq_get 'o.rows.length')"
[ "$ROW_COUNT" = "4" ] || fail "expected 4 list rows, got $ROW_COUNT"
pass "ccpp list shows 4 rows (commands x2, skill x1, agent x1)"

# -------- 5. ccpp sync (no-op) --------
say 'ccpp sync — should report no-changes'
SYNC_JSON="$(ccpp sync --json)"
APPLY_STATUS="$(echo "$SYNC_JSON" | jq_get 'o.sources[0].applyStatus')"
[ "$APPLY_STATUS" = "no-changes" ] || fail "expected no-changes, got $APPLY_STATUS"
pass "sync reports no-changes"

# -------- 6. ccpp status --------
say 'ccpp status'
STATUS_JSON="$(ccpp status --json)"
STATUS="$(echo "$STATUS_JSON" | jq_get 'o.sources[0].status')"
[ "$STATUS" = "up-to-date" ] || fail "expected up-to-date, got $STATUS"
pass "status reports up-to-date"

# -------- 7. ccpp checkout round-trip (master → add-cheer-agent → master) --------
#
# The `add-cheer-agent` branch on ccpp-test-pingpong differs from master:
#   - adds  agents/cheer.md
#   - modifies commands/ping.md (adds a "branch marker" line)
# So the round-trip exercises both diff directions: added + modified flipping
# one way on checkout-to-branch, then modified flipping back on checkout-home.

# Snapshot master's ping.md bytes before swapping branches — used to verify
# checkout actually rewrites the destination, not just the lockfile ref.
PING_FILE="$CLAUDE_HOME/commands/ping.md"
PING_MASTER_BYTES="$(cat "$PING_FILE")"
echo "$PING_MASTER_BYTES" | grep -q "Branch marker" \
  && fail "master's ping.md unexpectedly already has the branch marker"

# Dry-run first — should report changes but write nothing.
say "ccpp checkout $REMOTE $BRANCH --dry-run"
DRYRUN_JSON="$("$CCPP_BIN" checkout "$REMOTE" "$BRANCH" \
  --claude-home "$CLAUDE_HOME" --dry-run --json)"
DRY_FLAG="$(echo "$DRYRUN_JSON" | jq_get 'o.dryRun')"
DRY_ADDED="$(echo "$DRYRUN_JSON" | jq_get 'o.added.length')"
DRY_MODIFIED="$(echo "$DRYRUN_JSON" | jq_get 'o.modified.length')"
[ "$DRY_FLAG" = "true" ] || fail "expected dryRun=true, got $DRY_FLAG"
[ "$DRY_ADDED" = "1" ] || fail "expected 1 added in dry-run, got $DRY_ADDED"
[ "$DRY_MODIFIED" = "1" ] || fail "expected 1 modified in dry-run, got $DRY_MODIFIED"
[ ! -f "$CLAUDE_HOME/agents/cheer.md" ] || fail "dry-run materialised cheer.md (should not)"
[ "$(cat "$PING_FILE")" = "$PING_MASTER_BYTES" ] || fail "dry-run modified ping.md (should not)"
pass "dry-run: +1 added, ~1 modified, no writes"

# Real checkout — branch swap should rewrite ping.md and create cheer.md.
say "ccpp checkout $REMOTE $BRANCH"
CHECKOUT_JSON="$("$CCPP_BIN" checkout "$REMOTE" "$BRANCH" \
  --claude-home "$CLAUDE_HOME" --json)"
TO_REF="$(echo "$CHECKOUT_JSON" | jq_get 'o.toRef')"
FROM_REF="$(echo "$CHECKOUT_JSON" | jq_get 'o.fromRef')"
INSTALLED_COUNT="$(echo "$CHECKOUT_JSON" | jq_get 'o.installed.length')"
UPDATED_COUNT="$(echo "$CHECKOUT_JSON" | jq_get 'o.updated.length')"
[ "$TO_REF" = "$BRANCH" ] || fail "expected toRef=$BRANCH in checkout JSON, got $TO_REF"
[ "$FROM_REF" = "null" ] || info "fromRef was $FROM_REF (initial install used the default branch with no explicit ref)"
[ "$INSTALLED_COUNT" = "1" ] || fail "expected 1 installed (cheer.md), got $INSTALLED_COUNT"
[ "$UPDATED_COUNT" = "1" ] || fail "expected 1 updated (ping.md), got $UPDATED_COUNT"
pass "checkout reported 1 installed + 1 updated"

# Verify disk state: cheer.md exists, ping.md now has the branch marker.
[ -f "$CLAUDE_HOME/agents/cheer.md" ] || fail "agents/cheer.md missing after checkout to $BRANCH"
grep -q "Branch marker" "$PING_FILE" \
  || fail "ping.md does not contain the branch marker after checkout to $BRANCH"
pass "cheer.md materialized; ping.md rewritten with branch-marker bytes"

# Config + lockfile both record the new ref on the same source entry.
SRC_COUNT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("'"$CCPP_HOME_DIR"'/ccpp.config.json","utf8")).sources.length)')"
SRC_REF="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("'"$CCPP_HOME_DIR"'/ccpp.config.json","utf8")).sources[0].ref)')"
[ "$SRC_COUNT" = "1" ] || fail "expected 1 source in config, got $SRC_COUNT"
[ "$SRC_REF" = "$BRANCH" ] || fail "expected config.sources[0].ref=$BRANCH, got $SRC_REF"
LOCK_REF="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("'"$CCPP_HOME_DIR"'/ccpp.lock.json","utf8")).sources["'"$REMOTE"'"].ref)')"
[ "$LOCK_REF" = "$BRANCH" ] || fail "expected lockfile ref=$BRANCH, got $LOCK_REF"
pass "config + lockfile both pinned to $BRANCH"

# Checkout back to master — ping.md should be restored byte-for-byte.
say "ccpp checkout $REMOTE master (swap back)"
"$CCPP_BIN" checkout "$REMOTE" master \
  --claude-home "$CLAUDE_HOME" --quiet \
  || fail "checkout back to master failed"
SRC_REF_BACK="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("'"$CCPP_HOME_DIR"'/ccpp.config.json","utf8")).sources[0].ref)')"
[ "$SRC_REF_BACK" = "master" ] || fail "expected config.sources[0].ref=master after swap back, got $SRC_REF_BACK"
[ "$(cat "$PING_FILE")" = "$PING_MASTER_BYTES" ] || fail "ping.md not restored to master bytes after swap back"
pass "round-trip: ping.md restored byte-for-byte; config back on master"

# v0.2.5 orphan-cleanup: cheer.md was added by the branch and is no longer
# in master's manifest, so applyManifest's prune pass renamed it to
# .bak.<ts> and dropped the lockfile entry on the swap back.
[ ! -f "$CLAUDE_HOME/agents/cheer.md" ] \
  || fail "cheer.md should have been pruned on swap back (orphan cleanup)"
BAK_COUNT="$(ls "$CLAUDE_HOME/agents/"cheer.md.bak.* 2>/dev/null | wc -l)"
[ "$BAK_COUNT" -ge 1 ] || fail "expected a cheer.md.bak.<ts> file from the prune; found none"
pass "orphan cleanup: cheer.md renamed to .bak on swap back"

# No-op when already on master.
NOOP_JSON="$("$CCPP_BIN" checkout "$REMOTE" master \
  --claude-home "$CLAUDE_HOME" --json)"
NOOP_FLAG="$(echo "$NOOP_JSON" | jq_get 'o.noop')"
[ "$NOOP_FLAG" = "true" ] || fail "expected noop=true on same-ref checkout, got $NOOP_FLAG"
pass "re-running checkout on the same ref is a no-op"

# Tag round-trip — proves checkout handles tags too (v0.1.0 points at master's
# initial commit, so swap is a no-disk-change ref label flip + back).
say "ccpp checkout $REMOTE $TAG (tag round-trip)"
"$CCPP_BIN" checkout "$REMOTE" "$TAG" \
  --claude-home "$CLAUDE_HOME" --quiet \
  || fail "checkout to $TAG (tag) failed"
TAG_LOCK_REF="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("'"$CCPP_HOME_DIR"'/ccpp.lock.json","utf8")).sources["'"$REMOTE"'"].ref)')"
[ "$TAG_LOCK_REF" = "$TAG" ] || fail "expected lockfile ref=$TAG after tag checkout, got $TAG_LOCK_REF"
"$CCPP_BIN" checkout "$REMOTE" master --claude-home "$CLAUDE_HOME" --quiet \
  || fail "checkout back to master from tag failed"
pass "tag checkout + return to master OK"

# -------- 8. @v0.1.0 shorthand round-trip --------
say "ccpp install $REMOTE@$TAG (shorthand) on a fresh claude-home"
TAG_HOME="$SCRATCH/claude-tag"
"$CCPP_BIN" install "${REMOTE}@${TAG}" \
  --claude-home "$TAG_HOME" \
  --config "$SCRATCH/tag-cfg.json" \
  --lockfile "$SCRATCH/tag-lock.json" \
  --quiet \
  || fail "tag-shorthand install failed"
TAG_REF="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("'"$SCRATCH"'/tag-cfg.json","utf8")).sources[0].ref)')"
[ "$TAG_REF" = "$TAG" ] || fail "expected ref=$TAG in config, got $TAG_REF"
pass "config recorded ref=$TAG"

# -------- 9. ccpp uninstall round-trip --------
#
# After the round-trip in step 7, lockfile.installed should hold exactly 5
# entries — the 5 master files. The cheer.md orphan from add-cheer-agent
# was pruned by applyManifest's cleanup pass on the swap back, so it's not
# in the lockfile anymore (and its .bak.<ts> is on disk but not tracked).
say "ccpp uninstall $REMOTE"
UNINSTALL_JSON="$(ccpp uninstall "$REMOTE" --json)"
REMOVED_COUNT="$(echo "$UNINSTALL_JSON" | jq_get 'o.removed.length')"
BACKUPS_COUNT="$(echo "$UNINSTALL_JSON" | jq_get 'o.backups.length')"
[ "$REMOVED_COUNT" = "5" ] || fail "expected 5 removed (orphan was already pruned on checkout swap-back), got $REMOVED_COUNT"
[ "$BACKUPS_COUNT" = "5" ] || fail "expected 5 backups, got $BACKUPS_COUNT"
pass "uninstall removed 5 files, kept 5 .bak files (orphan already pruned in step 7)"

for f in "${EXPECTED[@]}"; do
  [ ! -f "$f" ] || fail "$f should be gone after uninstall"
done
pass "originals removed"

# Verify the .bak files exist (the uninstall JSON listed them).
for bak in $(echo "$UNINSTALL_JSON" | node -e '
  const o = JSON.parse(require("fs").readFileSync(0, "utf8"));
  for (const b of o.backups) console.log(b);
'); do
  [ -f "$bak" ] || fail "expected backup missing: $bak"
done
pass ".bak files present on disk"

# -------- 10. config no longer references the source --------
SOURCE_LIST="$(node -e '
  const path = "'"$CCPP_HOME_DIR"'/ccpp.config.json";
  const cfg = JSON.parse(require("fs").readFileSync(path, "utf8"));
  console.log(cfg.sources.length);
')"
[ "$SOURCE_LIST" = "0" ] || fail "config still references the uninstalled source"
pass "config.sources empty after uninstall"

echo
printf "${green}✓${reset} e2e-install: 10 steps passed\n"

#!/usr/bin/env bash
#
# ccpp SessionStart hook.
#
# `ccpp install-hook` writes a copy of this script to
# `${CCPP_HOME:-$HOME/.ccpp}/hook.sh` and points Claude Code's SessionStart
# entry at it. The hook MUST never block Claude Code — so we trap every
# possible failure, redirect stderr to the sync log, and always exit 0.
#
# If you are editing this file and something misbehaves, check:
#   ${CCPP_HOME:-$HOME/.ccpp}/sync.log

set +e

CCPP_HOME_DIR="${CCPP_HOME:-$HOME/.ccpp}"
LOG="$CCPP_HOME_DIR/sync.log"
NOTICE="$CCPP_HOME_DIR/last-hook-notice.txt"
mkdir -p "$CCPP_HOME_DIR" 2>/dev/null

{
  ccpp sync --auto-accept --trigger hook
} >/dev/null 2>>"$LOG"

# Surface a one-shot notice (e.g. agent changes that require a CC restart —
# see anthropics/claude-code#58592). Best-effort: missing file is fine.
if [ -s "$NOTICE" ]; then
  cat "$NOTICE" >&2
  rm -f "$NOTICE"
fi

exit 0

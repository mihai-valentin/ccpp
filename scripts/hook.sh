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

LOG="${CCPP_HOME:-$HOME/.ccpp}/sync.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null

{
  ccpp sync --auto-accept --trigger hook
} >/dev/null 2>>"$LOG"

exit 0

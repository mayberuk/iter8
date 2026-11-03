#!/usr/bin/env bash
set -uo pipefail

SELF="${BASH_SOURCE[0]}"
DIR="${SELF%/*}"
[ "$DIR" = "$SELF" ] && DIR=.
ROOT="$(cd -- "$DIR/.." && pwd)"
. "$ROOT/scripts/lib.sh"
HOOK_INPUT="$(cat)"
# claude -p sets CLAUDE_CODE_ENTRYPOINT=sdk-cli even under an interactive parent, and holds its start and exit
# on this hook; a print run never idles, so there is nothing to wake.
case "${CLAUDE_CODE_ENTRYPOINT:-}" in sdk-*) exit 0 ;; esac
command -v jq >/dev/null 2>&1 || exit 0
PID="$(agent_pid)"
if [ -z "$PID" ]; then
  iter8_log wake 'no non-shell ancestor found'
  exit 0
fi
EVENT="$(hook_input_field hook_event_name)"
if [ "$EVENT" = SessionStart ]; then
  unset ITER8_NO_INSTALL
else
  export ITER8_NO_INSTALL=1
fi
DATA="$(iter8_data_dir)"
mkdir -p "$DATA" 2>/dev/null || exit 0
ERRORS="$(mktemp "$DATA/wake-errors.XXXXXX" 2>/dev/null)" || exit 0
trap 'unlink "$ERRORS" 2>/dev/null || :' EXIT
wait_for_round() {
  "$ROOT/bin/iter8" hook wait --pid "$PID" --timeout-seconds 86100 >/dev/null 2> "$ERRORS"
  CODE=$?
}
wait_for_round
if [ "$CODE" -eq 3 ]; then
  if [ "$EVENT" != SessionStart ]; then
    iter8_log wake 'owner missing outside SessionStart'
    exit 0
  fi
  iter8_log wake 'owner missing at SessionStart; registering'
  LABEL="${CLAUDE_CODE_SESSION_ID:-}"
  [ -n "$LABEL" ] || LABEL="$(hook_input_field session_id)"
  if [ -z "$LABEL" ]; then
    iter8_log wake 'session label is missing'
    exit 0
  fi
  SOURCE="$(map_source "$(hook_input_field source)")"
  START="$(mktemp "$DATA/wake-start.XXXXXX" 2>/dev/null)" || exit 0
  trap 'unlink "$ERRORS" 2>/dev/null || :; unlink "$START" 2>/dev/null || :' EXIT
  ITER8_NO_INSTALL=1 "$ROOT/bin/iter8" hook start --pid "$PID" --label "$LABEL" --source "$SOURCE" --agent claude > "$START" 2>/dev/null
  START_CODE=$?
  if [ "$START_CODE" -ne 0 ]; then
    iter8_log wake "registration failed with exit $START_CODE"
    exit 0
  fi
  POINTERS="$(filter_pointers < "$START")"
  if [ -n "$POINTERS" ]; then
    printf '%s\n' "$POINTERS" >&2
    exit 2
  fi
  wait_for_round
  if [ "$CODE" -eq 3 ]; then
    iter8_log wake 'owner still missing after registration'
    exit 0
  fi
fi
if [ "$CODE" -eq 2 ]; then
  POINTERS="$(filter_pointers < "$ERRORS")"
  if [ -n "$POINTERS" ]; then
    printf '%s\n' "$POINTERS" >&2
    exit 2
  fi
fi
exit 0

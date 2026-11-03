#!/usr/bin/env bash
set -uo pipefail

SELF="${BASH_SOURCE[0]}"
DIR="${SELF%/*}"
[ "$DIR" = "$SELF" ] && DIR=.
ROOT="$(cd -- "$DIR/.." && pwd)"
. "$ROOT/scripts/lib.sh"
HOOK_INPUT="$(cat)"
EVENT="${1:-}"
STARTED=$SECONDS

# 5 is iter8's service-unavailable exit, routine once these hooks no longer start the service.
log_outcome() {
  local elapsed=$((SECONDS - STARTED)) reason=''
  if [ "$elapsed" -ge 2 ] || { [ "$1" -ne 0 ] && [ "$1" -ne 5 ]; }; then
    [ -z "${2:-}" ] || IFS= read -r reason <<< "$2" || :
    reason="${reason:0:200}"
    iter8_log "$EVENT" "exit=$1 seconds=$elapsed${reason:+ reason=$reason}"
  fi
}

first_line() {
  local line=''
  [ -r "$1" ] && IFS= read -r line < "$1" 2>/dev/null
  printf '%s' "$line"
}

if ! command -v jq >/dev/null 2>&1; then
  iter8_log "$EVENT" 'jq is not installed'
  if [ "$EVENT" = start ]; then
    printf '%s\n' 'iter8 hooks are off: jq is not installed.'
  fi
  exit 0
fi
PID="$(agent_pid)"
if [ -z "$PID" ]; then
  iter8_log "$EVENT" 'no non-shell ancestor found'
  exit 0
fi
LABEL="${CLAUDE_CODE_SESSION_ID:-}"
if [ "$EVENT" = start ] || [ "$EVENT" = end ]; then
  [ -n "$LABEL" ] || LABEL="$(hook_input_field session_id)"
  if [ -z "$LABEL" ]; then
    iter8_log "$EVENT" 'session label is missing'
    exit 0
  fi
fi

case "$EVENT" in
  start|prompt)
    DATA="$(iter8_data_dir)"
    mkdir -p "$DATA" 2>/dev/null || exit 0
    OUTPUT="$(mktemp "$DATA/hook-output.XXXXXX" 2>/dev/null)" || exit 0
    trap 'unlink "$OUTPUT" 2>/dev/null || :; unlink "$OUTPUT.err" 2>/dev/null || :' EXIT
    if [ "$EVENT" = start ]; then
      SOURCE="$(map_source "$(hook_input_field source)")"
      ITER8_NO_INSTALL=1 "$ROOT/bin/iter8" hook start --pid "$PID" --label "$LABEL" --source "$SOURCE" --agent claude > "$OUTPUT" 2>"$OUTPUT.err"
    else
      ITER8_NO_INSTALL=1 "$ROOT/bin/iter8" hook prompt --pid "$PID" > "$OUTPUT" 2>"$OUTPUT.err"
    fi
    CODE=$?
    log_outcome "$CODE" "$(first_line "$OUTPUT.err")"
    if [ "$CODE" -eq 0 ]; then
      filter_pointers 5 < "$OUTPUT"
    elif [ "$EVENT" = start ] && { [ "$CODE" -eq 69 ] || [ "$CODE" -eq 78 ]; }; then
      if [ -r "$DATA/install-error" ]; then
        REASON=''
        IFS= read -r REASON 2>/dev/null < "$DATA/install-error" || :
        printf 'iter8 is not installed: %s\n' "$REASON"
      fi
    fi
    ;;
  tool)
    [ -z "$(hook_input_field agent_id)" ] || exit 0
    DATA="$(iter8_data_dir)"
    mkdir -p "$DATA" 2>/dev/null || exit 0
    OUTPUT="$(mktemp "$DATA/hook-output.XXXXXX" 2>/dev/null)" || exit 0
    trap 'unlink "$OUTPUT" 2>/dev/null || :; unlink "$OUTPUT.err" 2>/dev/null || :' EXIT
    ITER8_NO_INSTALL=1 "$ROOT/bin/iter8" hook tool --pid "$PID" > "$OUTPUT" 2>"$OUTPUT.err"
    CODE=$?
    log_outcome "$CODE" "$(first_line "$OUTPUT.err")"
    [ "$CODE" -eq 0 ] || exit 0
    LINES="$(filter_pointers none < "$OUTPUT")"
    if [ -n "$LINES" ]; then
      jq -n --arg context "$LINES" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $context}}'
    fi
    ;;
  stop)
    ERR="$(printf '%s' "$HOOK_INPUT" | ITER8_NO_INSTALL=1 "$ROOT/bin/iter8" hook stop --pid "$PID" 2>&1 >/dev/null)"
    log_outcome "$?" "$ERR"
    ;;
  end)
    REASON="$(hook_input_field reason)"
    case "$REASON" in
      clear|resume|logout|prompt_input_exit|other) ;;
      *) REASON=other ;;
    esac
    ITER8_NO_INSTALL=1 nohup "$ROOT/bin/iter8" hook end --pid "$PID" --label "$LABEL" --reason "$REASON" </dev/null >/dev/null 2>&1 &
    ;;
  *) iter8_log hook 'unknown hook command' ;;
esac
exit 0

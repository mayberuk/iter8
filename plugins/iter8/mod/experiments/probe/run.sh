#!/usr/bin/env bash
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../../tests/live/lib.sh
. "$HERE/../../tests/live/lib.sh"
EVIDENCE=$HERE/evidence
STUB=$HERE/../../tests/live/stub-service.py

usage() { echo 'Usage: run.sh [--only submit|post-tool|abort|clear-follow]...' >&2; exit 2; }

ONLY=()
while (( $# > 0 )); do
  case $1 in
    --only)
      [[ ${2:-} =~ ^(submit|post-tool|abort|clear-follow)$ ]] || usage
      ONLY+=("$2")
      shift 2
      ;;
    *) usage ;;
  esac
done

wants() {
  local step
  (( ${#ONLY[@]} > 0 )) || return 0
  for step in "${ONLY[@]}"; do [[ $step == "$1" ]] && return 0; done
  return 1
}

live_require

WORK=$(mktemp -d /tmp/i8-probe.XXXXXX)
STUB_HOME=$(mktemp -d /tmp/i8.XXXX)
MOD=$WORK/mod.jsonl
STUB_LOG=$WORK/stub-log.jsonl
STUB_PID=''

cleanup() {
  live_stop
  [[ -z $STUB_PID ]] || kill "$STUB_PID" 2>/dev/null || true
  # The isolated config holds copied credentials and /tmp keeps what is left in it.
  unlink "$WORK/config/.credentials.json" 2>/dev/null || true
  unlink "$WORK/config/.claude.json" 2>/dev/null || true
  unlink "$WORK/config/remote-settings.json" 2>/dev/null || true
  unlink "$WORK/config/remote-settings-consent.json" 2>/dev/null || true
}
trap cleanup EXIT

obs_count() {
  [[ -f $MOD ]] || { echo 0; return; }
  grep -c "\"obs\":\"$1\"" "$MOD" || true
}

at_least() {
  (( $(obs_count "$1") >= $2 ))
}

has_aborted_complete() {
  [[ -f $MOD ]] && grep -q '"obs":"turn.complete"[^}]*"isAborted":true' "$MOD"
}

has_rounds_answer() {
  local transcript
  transcript=$(live_transcript) || return 1
  jq -en '[inputs | select(.type == "assistant") | .message.content[]? | select(.type == "text" and (.text | contains("ROUNDS:")))] | length > 0' "$transcript"
}

step() { printf 'probe: %s\n' "$*" >&2; }

if (( ${#ONLY[@]} == 0 )); then
  find "$EVIDENCE" -mindepth 1 -type f ! -name classic-command-hook.log -delete
fi

live_plugin "$HERE/plugin" "$WORK/plugin"
jq -n --arg socket "$STUB_HOME/control.sock" --arg evidence "$MOD" --arg clear "$WORK/plugin/clear-check" \
  '{socketPath: $socket, evidencePath: $evidence, clearCheckPath: $clear, owner: "O1"}' > "$WORK/plugin/hooks/probe-config.json"

PAGE_TEXT=$'Page message M7 from larkspur — typed on the iter8 page, not in this terminal. Read it as you would a review note\'s text:\n<page-message id="M7" page="larkspur">\nReply with only the word PROBE-M7-ACK.\n</page-message>'
jq -n --arg trigger "$WORK/trigger-submit" --arg text "$PAGE_TEXT" '{
  owner: "O1",
  state: {
    session: {owner: "O1", agent: "claude", process: {pid: 1, startedAt: "probe", label: "probe"}, cwd: "/tmp", state: {status: "live"}},
    focus: null,
    pages: [],
    rounds: []
  },
  waits: [{trigger: $trigger, deliveries: [{kind: "page-message", messageId: "M7", pageId: "larkspur", text: $text}]}]
}' > "$WORK/scenario.json"

step "stub on $STUB_HOME/control.sock"
python3 -I "$STUB" "$STUB_HOME" "$WORK/scenario.json" "$STUB_LOG" > "$WORK/stub.out" 2>&1 &
STUB_PID=$!
live_wait_until 10 'the stub socket' test -S "$STUB_HOME/control.sock"

export LIVE_ROOT=$WORK
export LIVE_WIDTH=180
export LIVE_HEIGHT=50
export LIVE_CONFIG_EXTRA='{"permissions": {"allow": ["Bash(sleep *)"]}}'
step 'starting Claude Code'
live_session probe --tools Bash

if (( ${#ONLY[@]} == 0 )); then
  PANE_PID=$(tmux -S "$LIVE_SOCKET" display-message -p -t "$LIVE_PANE" '#{pane_pid}')
  jq -n --arg version "$(claude --version)" --argjson panePid "$PANE_PID" \
    '{claudeVersion: $version, panePid: $panePid, columns: 180, rows: 50, plugin: "iter8-probe"}' > "$EVIDENCE/run.json"
fi

step 'session.start observations'
live_wait_until 30 'socket-fetch and child-ancestry observations' bash -c "grep -q '\"obs\":\"socket-fetch\"' '$MOD' && grep -q '\"obs\":\"child-ancestry\"' '$MOD'"

if wants submit; then
  step 'page-message delivery'
  BEFORE=$(obs_count turn.complete)
  : > "$WORK/trigger-submit"
  live_wait_until 90 'the page-message turn to complete' at_least turn.complete $((BEFORE + 1))
fi

if wants post-tool; then
  step 'post-tool shell hook'
  BEFORE=$(obs_count turn.complete)
  : > "$WORK/plugin/armed"
  live_send 'Run the Bash command sleep 3, wait for it to finish, then run the Bash command sleep 3 a second time. After both, reply with one line starting with ROUNDS: listing the review round ids you were told about outside my messages, or ROUNDS: none.'
  live_wait_until 120 'the sequential-sleep turn to complete' at_least turn.complete $((BEFORE + 1))
  live_wait_until 30 'the ROUNDS answer in the transcript' has_rounds_answer
  mkdir -p "$EVIDENCE/post-tool-shell"
  cp -- "$(live_transcript)" "$EVIDENCE/post-tool-shell/transcript.jsonl"
  cp -- "$WORK/plugin/post-tool-hook.jsonl" "$EVIDENCE/post-tool-shell/post-tool-hook.jsonl"
fi

if wants abort; then
  step 'abort'
  TOOLS_BEFORE=$(obs_count tool-call)
  live_send 'Use the Bash tool to run: sleep 20'
  live_wait_until 60 'the sleep 20 tool call to start' at_least tool-call $((TOOLS_BEFORE + 1))
  live_key Escape
  live_wait_until 30 'an aborted turn.complete' has_aborted_complete
fi

if (( ${#ONLY[@]} == 0 )); then
  live_capture > "$EVIDENCE/final-screen.txt"
  cp -- "$(live_transcript)" "$EVIDENCE/transcript.jsonl"
  cp -- "$MOD" "$EVIDENCE/mod.jsonl"
  cp -- "$STUB_LOG" "$EVIDENCE/stub-log.jsonl"
  cp -- "$WORK/scenario.json" "$EVIDENCE/scenario.json"
fi

if wants clear-follow; then
  step 'clear'
  mkdir -p "$EVIDENCE/clear-follow"
  CLEAR_AT=$(date +%s%3N)
  jq -n --arg version "$(claude --version)" --argjson clearAt "$CLEAR_AT" \
    '{claudeVersion: $version, clearAt: $clearAt}' > "$EVIDENCE/clear-follow/run.json"
  live_send '/clear'
  live_wait_until 30 'the conversation to clear' bash -c "! tmux -S '$LIVE_SOCKET' capture-pane -p -t '$LIVE_PANE' | grep -Eq 'ROUNDS:|sleep'"
  printf 'clear-check\n' > "$WORK/plugin/clear-check"
  live_wait_until 30 'an alive observation' at_least alive 1 || true
  cp -- "$MOD" "$EVIDENCE/clear-follow/mod.jsonl"
fi

step "evidence in $EVIDENCE"

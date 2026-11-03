#!/usr/bin/env bash
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
EVIDENCE=$HERE/evidence
RESULT=$HERE/RESULT.md
POINTER='Review round R5 from larkspur · 1 note — run `iter8 show R5`'

for f in run.json mod.jsonl transcript.jsonl scenario.json classic-command-hook.log \
  post-tool-shell/post-tool-hook.jsonl post-tool-shell/transcript.jsonl clear-follow/mod.jsonl clear-follow/run.json; do
  [[ -f $EVIDENCE/$f ]] || { printf 'check: evidence/%s is missing; run run.sh first\n' "$f" >&2; exit 2; }
done

MOD=$EVIDENCE/mod.jsonl
TRANSCRIPT=$EVIDENCE/transcript.jsonl

mod() { jq -c --arg obs "$1" 'select(.obs == $obs)' "$MOD"; }
count() { mod "$1" | wc -l | tr -d ' '; }

declare -A verdict detail
set_result() { verdict[$1]=$2; detail[$1]=$3; }

socket_fetch() {
  local row
  row=$(mod socket-fetch | head -n 1)
  if [[ -n $row ]] && jq -e '.status == 200 and ((.body | fromjson | .session.owner) == "O1")' <<< "$row" >/dev/null 2>&1; then
    set_result socket-fetch confirmed '$.http.fetch with socketPath reached the stub: status 200 and the /agent/state body (owner O1)'
  else
    set_result socket-fetch refuted "no socket-fetch observation with status 200 and the stub body: ${row:-none}"
  fi
}

SENDER=''
TRAILER=''
submit_turn() {
  local delivery content result_drop acked
  delivery=$(jq -r '.waits[0].deliveries[0].text' "$EVIDENCE/scenario.json")
  content=$(jq -r --arg d "$delivery" 'select(.type == "user" and .origin.kind == "plugin" and (.message.content | type == "string") and (.message.content | contains($d))) | .message.content' "$TRANSCRIPT" | head -c 100000)
  result_drop=$(mod submit-result | jq -r '.drop' | head -n 1)
  acked=$(jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text' "$TRANSCRIPT" | grep -c 'PROBE-M7-ACK' || true)
  if [[ -n $content && $result_drop == null && $acked -ge 1 ]]; then
    SENDER=${content%%"$delivery"*}
    TRAILER=${content#*"$delivery"}
    set_result submit-turn confirmed '$.prompt.submit between turns wrote one plugin-origin user row holding sender sentence, delivery text verbatim and trailer; it started a turn and the model answered PROBE-M7-ACK'
  else
    set_result submit-turn refuted "plugin-origin row with the delivery text: ${content:+found}${content:-absent}; submit-result drop: ${result_drop:-none}; acknowledgements: $acked"
  fi
}

post_tool_shell() {
  local dir=$EVIDENCE/post-tool-shell armed pointer_rows pointer_types answer
  armed=$(jq -c 'select(.armed == true and .hasAgentId == false)' "$dir/post-tool-hook.jsonl" | wc -l | tr -d ' ')
  pointer_rows=$(jq -c --arg p "$POINTER" 'select(.type == "attachment" and (tostring | contains($p)))' "$dir/transcript.jsonl" | wc -l | tr -d ' ')
  pointer_types=$(jq -r --arg p "$POINTER" 'select(.type == "attachment" and (tostring | contains($p))) | .attachment.type' "$dir/transcript.jsonl" | sort | uniq -c | awk '{printf "%s%s×%s", sep, $2, $1; sep=", "}')
  answer=$(jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "text" and (.text | contains("ROUNDS:"))) | .text' "$dir/transcript.jsonl" | grep '^ROUNDS:' | tail -n 1 || true)
  if (( armed >= 1 && pointer_rows >= 1 )) && [[ $answer == *R5* ]]; then
    set_result post-tool-shell confirmed "the plugin's PostToolUse command hook ran armed on $armed main-conversation call(s) and printed hookSpecificOutput.additionalContext; the pointer is in $pointer_rows transcript row(s) (${pointer_types:-none}) and the answer was: $answer"
  else
    set_result post-tool-shell refuted "armed main-conversation hook runs: $armed; pointer in $pointer_rows attachment row(s); last ROUNDS line: ${answer:-none}"
  fi
}

post_tool_module() {
  local seen hooklog
  seen=$(count post-tool)
  hooklog=$(wc -l < "$EVIDENCE/classic-command-hook.log" | tr -d ' ')
  MODULE_LINE="post-tool-module: recorded — the module saw $seen classic.PostToolUse events although the engine ran the plugin's own PostToolUse command hook $hooklog time(s) and $(count tool-call) tool.call events fired"
}

turn_events() {
  local starts completes aborted answered subagent
  starts=$(count turn.start)
  completes=$(count turn.complete)
  aborted=$(mod turn.complete | jq -c 'select(.isAborted == true and .reason == "aborted")' | wc -l | tr -d ' ')
  answered=$(mod turn.complete | jq -c 'select(.isAborted == false and .reason == "answer")' | wc -l | tr -d ' ')
  subagent=$( { mod turn.start; mod turn.complete; } | jq -c 'select(.hasAgentId == true)' | wc -l | tr -d ' ')
  if (( starts >= 3 && completes >= 3 && aborted >= 1 && answered >= 2 && subagent == 0 )) &&
     [[ $(mod turn.start | jq -r '.turnId' | sort) == $(mod turn.complete | jq -r '.turnId' | sort) ]]; then
    set_result turn-events confirmed "$starts turn.start and $completes turn.complete events on the main thread, ids paired; $answered ended reason answer and $aborted ended isAborted true reason aborted after Esc"
  else
    set_result turn-events refuted "turn.start $starts, turn.complete $completes, answered $answered, aborted $aborted, agent-owned $subagent"
  fi
}

append_doors() {
  local table
  table=$(mod append | jq -r '"\(.door)/\(.originKind)"' | sort | uniq -c | awk '{printf "%s%s×%s", sep, $2, $1; sep=", "}')
  if [[ $table == *prompt/plugin* && $table == *prompt/composer* && $table == *response/model* && $table == *tool-result/tool* && $table == *attachment/engine* ]] &&
     (( $(mod append | jq -c 'select(.door == "prompt" and .originKind == "plugin" and .messageType == "user")' | wc -l) == 1 )); then
    set_result append-doors confirmed "session.append carries door and origin.kind: $table"
  else
    set_result append-doors refuted "door/origin pairs seen: ${table:-none}"
  fi
}

child_ancestry() {
  local panePid chain claude_pid sh_ppid
  panePid=$(jq -r '.panePid' "$EVIDENCE/run.json")
  chain=$(mod child-ancestry | head -n 1 | jq -r '.stdout')
  claude_pid=$(awk -v pane="$panePid" '$1 == pane && $3 == "claude" { print $1 }' <<< "$chain")
  sh_ppid=$(awk '$3 == "sh" { print $2; exit }' <<< "$chain")
  if [[ -n $claude_pid && $sh_ppid == "$claude_pid" ]]; then
    set_result child-ancestry confirmed "a \$.process.run child's parent chain is sh ← claude (pid $claude_pid, the tmux pane's process) ← tmux server; the \`sh\` is the shell \$.process.run wraps the command in, so the agent pid is the first non-shell ancestor"
  else
    set_result child-ancestry refuted "ancestry chain did not reach the pane's claude pid $panePid: ${chain:-none}"
  fi
}

clear_follow() {
  local dir=$EVIDENCE/clear-follow clear_at first alive_row alive_instance alive_at starts ends
  clear_at=$(jq -r '.clearAt' "$dir/run.json")
  first=$(jq -rs 'map(select(.obs == "session.start")) | first | .instance // ""' "$dir/mod.jsonl")
  alive_row=$(jq -c --argjson at "$clear_at" 'select(.obs == "alive" and .at > $at)' "$dir/mod.jsonl" | head -n 1)
  starts=$(jq -c --argjson at "$clear_at" 'select(.obs == "session.start" and .at > $at)' "$dir/mod.jsonl" | wc -l | tr -d ' ')
  ends=$(jq -c --argjson at "$clear_at" 'select(.obs == "session.end" and .at > $at)' "$dir/mod.jsonl" | wc -l | tr -d ' ')
  if [[ -z $alive_row ]]; then
    set_result clear-follow refuted "no alive line after /clear (clearAt $clear_at); session.start firings after it: $starts, session.end: $ends"
    return
  fi
  alive_instance=$(jq -r '.instance' <<< "$alive_row")
  alive_at=$(jq -r '.at' <<< "$alive_row")
  if [[ $alive_instance == "$first" ]]; then
    set_result clear-follow confirmed "the first module instance ($first) survived /clear: its poll loop recorded alive $((alive_at - clear_at)) ms after /clear; after it $starts session.start and $ends session.end firing(s)"
  else
    set_result clear-follow confirmed "a repeated session.start began a new loop: instance $alive_instance (first instance $first) recorded alive $((alive_at - clear_at)) ms after /clear; after it $starts session.start and $ends session.end firing(s)"
  fi
}

socket_fetch
submit_turn
post_tool_shell
turn_events
append_doors
child_ancestry
clear_follow
post_tool_module

order=(socket-fetch submit-turn post-tool-shell turn-events append-doors child-ancestry clear-follow)
{
  printf '# iter8 mod probe results\n\n'
  printf 'Measured with %s. Verdicts are recomputed from `evidence/` by `bash check.sh`.\n\n' "$(jq -r '.claudeVersion' "$EVIDENCE/run.json")"
  printf '```text\n'
  for name in "${order[@]}"; do
    printf '%s: %s — %s\n' "$name" "${verdict[$name]}" "${detail[$name]}"
  done
  printf '%s\n' "$MODULE_LINE"
  printf '```\n'
  if [[ -n $SENDER ]]; then
    printf '\nSender sentence, verbatim (text before the delivery):\n\n```text\n%s\n```\n' "$SENDER"
    printf '\nTrailer, verbatim (text after the delivery):\n\n```text\n%s\n```\n' "$TRAILER"
  fi
} > "$RESULT"

status=0
for name in "${order[@]}"; do
  printf '%s: %s\n' "$name" "${verdict[$name]}"
  [[ ${verdict[$name]} == confirmed ]] || status=1
done
printf '%s\n' "$MODULE_LINE"
exit "$status"

#!/usr/bin/env bash
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
PLUGIN_SOURCE=$(cd -- "$HERE/../../.." && pwd)
STUB=$HERE/stub-service.py

ROUND_POINTER='Review round R4 from larkspur · 2 notes — run `iter8 show R4`'
SEND_NOW_POINTER='Review round R7 from larkspur · 1 note — run `iter8 show R7`'
OWNER=O-live
OWNER_PID=4242
SLEEP_PROMPT='Run the Bash command sleep 3, wait for it to finish, then run the Bash command sleep 3 a second time. After both, reply with one line starting with ROUNDS: listing the review round ids you were told about outside my messages, or ROUNDS: none.'

failures=0
pass() { printf 'PASS %s\n' "$*"; }
defect() {
  failures=$((failures + 1))
  printf 'FAIL %s\n' "$*" >&2
}
fatal() {
  defect "$@"
  if [[ -n ${LIVE_PANE:-} ]]; then
    printf -- '--- screen ---\n' >&2
    live_screen >&2 || true
  fi
  printf 'FAIL live round: stopped; evidence is in %s\n' "$WORK" >&2
  exit 1
}
step() { printf 'round: %s\n' "$*" >&2; }

live_require

WORK=$(mktemp -d /tmp/iter8-live-round.XXXXXX)
STUB_HOME=$(mktemp -d /tmp/i8.XXXX)
STUB_LOG=$WORK/stub-log.jsonl
FAKE_LOG=$WORK/fake-iter8.log
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
trap 'exit 130' INT
trap 'exit 143' TERM

now_ms() { date +%s%3N; }

turn_states_since() {
  [[ -f $STUB_LOG ]] || return 0
  jq -r --argjson since "$1" 'select(.path == "/agent/turn" and .at >= $since) | .body.state' "$STUB_LOG" 2>/dev/null || true
}

idle_since() { turn_states_since "$1" | grep -qx idle; }

waiting() { [[ -f $STUB_LOG ]] && jq -e 'select(.path == "/agent/wait")' "$STUB_LOG" >/dev/null; }

transcript_rows() {
  local transcript
  transcript=$(live_transcript) || return 0
  # A row still being written fails to parse; the rows before it still count.
  jq -rc "$1" "$transcript" 2>/dev/null || true
}

sleep_started() {
  [[ -n $(transcript_rows 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use" and (.input.command // "" | test("^sleep 3")))') ]]
}

rounds_answer() {
  transcript_rows 'select(.type == "assistant") | .message.content[]? | select(.type == "text" and (.text | contains("ROUNDS:"))) | .text'
}

has_rounds_answer() { [[ -n $(rounds_answer) ]]; }

forwarded_rows() {
  [[ -f $STUB_LOG ]] || return 0
  jq -c 'select(.method == "POST" and .path == "/agent/transcript") | .body.rows[]' "$STUB_LOG" 2>/dev/null || true
}

assistant_forwarded() { forwarded_rows | jq -e 'select(.role == "assistant" and (.text | contains("ROUNDS:")))' >/dev/null; }

mkdir -p "$WORK/fakebin" "$WORK/data"
FAKE=$WORK/fakebin/iter8
jq -n --arg home "$STUB_HOME" --arg owner "$OWNER" --argjson pid "$OWNER_PID" '{
  state: "ready", version: "0.1.0", build: "live", protocolVersion: 2, schemaVersion: 3,
  machineId: "m-live", machineName: "live", pid: 900, home: $home, pool: [4100], overlay: "present",
  owner: {
    owner: $owner, agent: "claude",
    process: {pid: $pid, startedAt: "2026-10-10T11:00:00.000Z", label: "claude (live)"},
    cwd: "/tmp", generation: 1, state: {status: "live"}, relabelPending: false, listener: "none"
  }
}' > "$WORK/status.json"
{
  printf '#!/usr/bin/env bash\n'
  printf 'STATUS=%q\nLOG=%q\nTRIGGER=%q\nONCE=%q\nPOINTER=%q\n' \
    "$WORK/status.json" "$FAKE_LOG" "$WORK/trigger-send-now" "$WORK/send-now-printed" "$SEND_NOW_POINTER"
  cat <<'FAKE'
printf '%s\n' "$*" >> "$LOG"
case "$1 ${2:-}" in
  'status --json') cat -- "$STATUS" ;;
  'hook tool')
    if [ -e "$TRIGGER" ] && mkdir -- "$ONCE" 2>/dev/null; then
      printf '%s\n' "$POINTER"
      printf 'printed %s\n' "$POINTER" >> "$LOG"
    fi
    ;;
  hook\ *) ;;
  'show '*) printf 'Round %s is a live-test fixture with nothing to change. Reply with only the word DONE.\n' "$2" ;;
  *) exit 64 ;;
esac
FAKE
} > "$FAKE"
chmod +x "$FAKE"

jq -n --arg owner "$OWNER" --argjson pid "$OWNER_PID" --arg trigger "$WORK/trigger-round" --arg text "$ROUND_POINTER" '
  def note(id; status): {id: id, pageId: "larkspur", author: {kind: "user"}, intent: "fix", body: ("body of " + id),
    target: {kind: "page"}, anchorStatus: "anchored", createdAt: "2026-10-10T11:00:00.000Z", resolution: {status: status}};
  {
    owner: $owner,
    state: {
      session: {owner: $owner, agent: "claude", process: {pid: $pid, startedAt: "2026-10-10T11:00:00.000Z", label: "claude (live)"}, cwd: "/tmp", state: {status: "live"}},
      focus: {pageId: "larkspur", roundId: "R4"},
      pages: [{pageId: "larkspur", origin: "http://localhost:3000", chat: {enabled: true, defaultEnabled: false, reachable: true}}],
      rounds: [{id: "R4", pageId: "larkspur", owner: $owner, state: {stage: "claimed", queuedAt: "a", idempotencyKey: "k", claimedAt: "b"},
        notes: [note("N2"; "open"), note("N3"; "open")]}]
    },
    waits: [{trigger: $trigger, deliveries: [{kind: "round", pointer: {roundId: "R4", pageId: "larkspur", noteCount: 2}, text: $text}]}]
  }' > "$WORK/scenario.json"

step "stub on $STUB_HOME/control.sock"
python3 -I "$STUB" "$STUB_HOME" "$WORK/scenario.json" "$STUB_LOG" > "$WORK/stub.out" 2>&1 &
STUB_PID=$!
live_wait_until 10 'the stub socket' test -S "$STUB_HOME/control.sock" || fatal 'the stub service did not start'

live_plugin "$PLUGIN_SOURCE" "$WORK/plugin"
ITER8_BIN=$FAKE
ITER8_PLUGIN_DATA=$WORK/data
PATH=$WORK/fakebin:$PATH
LIVE_PASS_ENV='ITER8_BIN ITER8_PLUGIN_DATA PATH'
export LIVE_ROOT=$WORK LIVE_WIDTH=180 LIVE_HEIGHT=50
export LIVE_CONFIG_EXTRA='{"permissions": {"allow": ["Bash(sleep *)", "Bash(iter8 show *)"]}}'
step 'starting Claude Code'
live_session round --tools Bash || fatal 'the session did not start'

live_wait_until 30 'the mod to open the wait route' waiting || fatal 'the mod never called /agent/wait after session.start'
grep -qx 'status --json' "$FAKE_LOG" || defect 'the mod attached without running iter8 status --json through ITER8_BIN'
pass 'session.start attached the mod and opened /agent/wait'

step 'round delivery'
ROUND_AT=$(now_ms)
: > "$WORK/trigger-round"
live_wait_until 120 'the round turn to post idle' idle_since "$ROUND_AT" || fatal 'the round delivery turn never posted idle'
states=$(turn_states_since "$ROUND_AT" | jq -Rrs 'split("\n") | map(select(. != "")) | .[0:2] | join(" ")')
if [[ $states == 'busy idle' ]]; then
  pass '/agent/turn received busy then idle for the round turn'
else
  defect "/agent/turn received [$states] for the round turn, expected [busy idle]"
fi
plugin_turns=$(transcript_rows 'select(.type == "user" and .origin.kind == "plugin" and .origin.name == "iter8") | .message.content | if type == "string" then . else map(.text // "") | join("\n") end')
if grep -Fq -- "$ROUND_POINTER" <<< "$plugin_turns"; then
  pass 'the round delivery became an iter8 plugin-origin turn carrying the pointer unchanged'
else
  defect "no iter8 plugin-origin turn carries the pointer; plugin turns: $(jq -Rsc . <<< "$plugin_turns")"
fi

step 'Send now between tool calls'
SEND_AT=$(now_ms)
live_send "$SLEEP_PROMPT"
live_wait_until 60 'the first sleep 3 tool call' sleep_started || fatal 'Claude never started a sleep 3 Bash call'
: > "$WORK/trigger-send-now"
live_wait_until 120 'the ROUNDS answer' has_rounds_answer || fatal 'Claude never answered with a ROUNDS: line'
live_wait_until 30 'the sleep turn to post idle' idle_since "$SEND_AT" || defect 'the sleep turn never posted idle'

grep -Fqx -- "printed $SEND_NOW_POINTER" "$FAKE_LOG" || defect 'iter8 hook tool never printed the Send-now pointer'
contexts=$(transcript_rows 'select(.type == "attachment" and .attachment.type == "hook_additional_context" and .attachment.hookEvent == "PostToolUse") | .attachment.content')
if jq -e --arg p "$SEND_NOW_POINTER" 'select(. == [$p])' >/dev/null 2>&1 <<< "$contexts"; then
  pass 'the PostToolUse command hook handed Claude exactly the Send-now pointer as additional context'
else
  defect "no PostToolUse additional context equal to the pointer; saw: $(jq -sc . <<< "$contexts" 2>/dev/null)"
fi
answer=$(rounds_answer)
if grep -q 'R7' <<< "$answer"; then
  pass "Claude named the Send-now round: $(head -n 1 <<< "$answer")"
else
  defect "Claude's answer did not name R7: $(jq -Rsc . <<< "$answer")"
fi

step 'transcript forwarding'
live_wait_until 30 'the ROUNDS reply on /agent/transcript' assistant_forwarded || defect 'the assistant reply never reached /agent/transcript'
assistant_uuids=$(transcript_rows 'select(.type == "assistant") | .uuid')
reply_keys=$(forwarded_rows | jq -r 'select(.role == "assistant" and (.text | contains("ROUNDS:"))) | .key')
if [[ -n $reply_keys ]] && ! grep -Fvxf <(printf '%s\n' "$assistant_uuids") <<< "$reply_keys" | grep -q .; then
  pass 'the assistant reply reached /agent/transcript keyed by its transcript row uuid'
else
  defect "the forwarded reply keys [$(paste -sd ' ' - <<< "$reply_keys")] are not assistant row uuids"
fi
if forwarded_rows | jq -e --arg text "$SLEEP_PROMPT" 'select(.role == "user" and .text == $text and (.key | length) > 0)' >/dev/null; then
  pass 'the typed prompt reached /agent/transcript with a key'
else
  defect 'the typed prompt never reached /agent/transcript with a key'
fi
if forwarded_rows | jq -e --arg p "$ROUND_POINTER" 'select(.role == "user" and (.text | contains($p)))' >/dev/null; then
  defect 'the plugin-origin round turn was forwarded to /agent/transcript as a person row'
fi

(( failures == 0 )) || { printf 'FAIL live round: %s failure(s); evidence is in %s\n' "$failures" "$WORK" >&2; exit 1; }
echo "PASS live round: attach, round turn with busy/idle, Send now through PostToolUse, transcript forwarding"

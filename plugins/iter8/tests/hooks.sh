#!/usr/bin/env bash
set -uo pipefail

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() {
  if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (expected '$2', got '$1')"; fi
}
assert_contains() {
  if [[ "$1" = *"$2"* ]]; then pass "$3"; else fail "$3 (missing '$2')"; fi
}

SELF="${BASH_SOURCE[0]}"
DIR="${SELF%/*}"
[ "$DIR" = "$SELF" ] && DIR=.
ROOT="$(cd -- "$DIR/.." && pwd)"
for TOOL in jq bash; do
  command -v "$TOOL" >/dev/null 2>&1 || { fail "$TOOL is required"; exit "$FAIL"; }
done
TMP="$(mktemp -d)" || exit 1
cleanup() { find "$TMP" -depth -delete; }
trap cleanup EXIT
export HOME="$TMP/home" XDG_DATA_HOME="$TMP/xdg" TMPDIR="$TMP"
mkdir -p "$HOME" "$XDG_DATA_HOME" "$TMP/tools" "$TMP/no-jq"
ln -s "$ROOT/tests/fixtures/fake-ps" "$TMP/tools/ps"
for TOOL in bash cat ps mkdir wc date mktemp unlink nohup sleep; do
  if [ "$TOOL" = ps ]; then LOCATION="$ROOT/tests/fixtures/fake-ps"; else LOCATION="$(command -v "$TOOL")"; fi
  ln -s "$LOCATION" "$TMP/no-jq/$TOOL"
done
TEST_PATH="$TMP/tools:$PATH"
export ITER8_BIN="$ROOT/tests/fixtures/fake-iter8" FAKE_ITER8_LOG="$TMP/calls" FAKE_PS_TABLE="$TMP/processes"
export CLAUDE_CODE_SESSION_ID='session env label'
unset ITER8_PLUGIN_DATA ITER8_NO_INSTALL FAKE_ITER8_REGISTERED FAKE_ITER8_START FAKE_ITER8_VERSION CLAUDE_CODE_ENTRYPOINT
DATA="$XDG_DATA_HOME/iter8-claude-plugin"
HOOK="$ROOT/scripts/hook.sh"
WAKE="$ROOT/scripts/wake.sh"
INPUT='{"session_id":"json label","source":"clear","hook_event_name":"SessionStart","reason":"clear"}'
POINTER_ONE='Review round R12 from larkspur · 7 notes — run `iter8 show R12`'
POINTER_TWO='Review round R3 from ab · 1 note — run `iter8 show R3`'
POINTERS="$POINTER_ONE"$'\n'"$POINTER_TWO"
EXPECTED_FIVE='Review round R1 from larkspur · 2 notes — run `iter8 show R1`
Review round R2 from larkspur · 2 notes — run `iter8 show R2`
Review round R3 from larkspur · 2 notes — run `iter8 show R3`
Review round R4 from larkspur · 2 notes — run `iter8 show R4`
Review round R5 from larkspur · 2 notes — run `iter8 show R5`'
normal_ancestry() {
  printf '%s\n' "$$ 4101 /bin/-bash" '4101 4242 /bin/sh' '4242 1 node' > "$FAKE_PS_TABLE"
}
run() {
  : > "$FAKE_ITER8_LOG"
  printf '%s' "$INPUT" | env PATH="$TEST_PATH" "$@" > "$TMP/stdout" 2> "$TMP/stderr"
  RC=$?
  OUT="$(<"$TMP/stdout")"
  ERR="$(<"$TMP/stderr")"
  CALLS="$(<"$FAKE_ITER8_LOG")"
}
quiet() {
  assert_eq "$RC" 0 "$1 exits 0"
  assert_eq "$OUT" '' "$1 stdout is empty"
  assert_eq "$ERR" '' "$1 stderr is empty"
}
await_end() {
  local attempt
  attempt=0
  while [ ! -s "$FAKE_ITER8_LOG" ] && [ "$attempt" -lt 60 ]; do
    sleep 0.1
    attempt=$((attempt + 1))
  done
  sleep 0.1
  CALLS="$(<"$FAKE_ITER8_LOG")"
}

printf '%s\n' 'iter8 hook and wake tests'
normal_ancestry
export FAKE_ITER8_MODE=pointer
run "$HOOK" start
assert_eq "$RC" 0 'start exits 0'
assert_eq "$CALLS" $'hook\tstart\t--pid\t4242\t--label\tsession env label\t--source\tclear\t--agent\tclaude\tITER8_NO_INSTALL=1' 'start preserves flags, label and first non-shell pid'
assert_eq "$OUT" "$POINTERS" 'start relays exactly stdout pointers'
assert_eq "$ERR" '' 'start stderr is empty'
for SOURCE in fork startup resume compact nonsense ''; do
  INPUT="$(jq -cn --arg source "$SOURCE" '{source:$source,session_id:"json label"}')"
  case "$SOURCE" in fork) MAPPED=resume ;; nonsense|'') MAPPED=startup ;; *) MAPPED="$SOURCE" ;; esac
  run "$HOOK" start
  assert_eq "$CALLS" "$(printf 'hook\tstart\t--pid\t4242\t--label\tsession env label\t--source\t%s\t--agent\tclaude\tITER8_NO_INSTALL=1' "$MAPPED")" "source '$SOURCE' maps to $MAPPED"
done
export CLAUDE_CODE_SESSION_ID=''
run "$HOOK" start
assert_eq "$CALLS" $'hook\tstart\t--pid\t4242\t--label\tjson label\t--source\tstartup\t--agent\tclaude\tITER8_NO_INSTALL=1' 'empty environment label falls back to JSON'
export CLAUDE_CODE_SESSION_ID='session env label'
run "$HOOK" prompt
assert_eq "$CALLS" $'hook\tprompt\t--pid\t4242\tITER8_NO_INSTALL=1' 'prompt argv is exact'
assert_eq "$OUT" "$POINTERS" 'prompt relays exactly stdout pointers'
assert_eq "$ERR" '' 'prompt discards CLI stderr'
export FAKE_ITER8_STDIN="$TMP/stop-stdin"
run "$HOOK" stop
unset FAKE_ITER8_STDIN
quiet stop
assert_eq "$CALLS" $'hook\tstop\t--pid\t4242\tITER8_NO_INSTALL=1' 'stop argv is exact'
assert_eq "$(<"$TMP/stop-stdin")" "$INPUT" 'stop pipes the hook input to the CLI'

for EVENT in SessionStart UserPromptSubmit Stop; do
  INPUT="$(jq -cn --arg event "$EVENT" '{hook_event_name:$event}')"
  export ITER8_NO_INSTALL=1
  run "$WAKE"
  if [ "$EVENT" = SessionStart ]; then FLAG='<unset>'; else FLAG=1; fi
  assert_eq "$CALLS" "$(printf 'hook\twait\t--pid\t4242\t--timeout-seconds\t86100\tITER8_NO_INSTALL=%s' "$FLAG")" "$EVENT wake has exact argv and install flag"
  assert_eq "$RC" 2 "$EVENT wake returns 2"
  assert_eq "$OUT" '' "$EVENT wake stdout is empty"
  assert_eq "$ERR" "$POINTERS" "$EVENT wake relays stderr pointers"
done
unset ITER8_NO_INSTALL
WAIT_SECONDS="$(printf '%s\n' "$CALLS" | jq -Rr 'split("\t") | .[index("--timeout-seconds") + 1]')"

for MODE in leak toolong mismatch plural; do
  export FAKE_ITER8_MODE="$MODE"
  case "$MODE" in leak) EXPECTED="$POINTER_ONE" ;; toolong) EXPECTED="$EXPECTED_FIVE" ;; *) EXPECTED='' ;; esac
  for COMMAND in start prompt wake; do
    if [ "$COMMAND" = wake ]; then run "$WAKE"; else run "$HOOK" "$COMMAND"; fi
    if [ "$COMMAND" = wake ] && [ -n "$EXPECTED" ]; then
      assert_eq "$RC" 2 "$MODE wake returns 2 for surviving pointers"
      assert_eq "$OUT" '' "$MODE wake stdout is empty"
      assert_eq "$ERR" "$EXPECTED" "$MODE wake filters stderr"
    else
      assert_eq "$RC" 0 "$MODE $COMMAND exits 0"
      assert_eq "$OUT" "$EXPECTED" "$MODE $COMMAND filters stdout"
      assert_eq "$ERR" '' "$MODE $COMMAND stderr is empty"
    fi
  done
done
LOG="$(<"$DATA/hooks.log")"
assert_contains "$LOG" 'dropped bytes=19' 'dropped note logs only its byte length'
assert_contains "$LOG" 'dropped bytes=30' 'dropped capture logs only its byte length'
if [[ "$LOG" = *secret* ]] || [[ "$LOG" = *'Review round'* ]]; then fail 'log contains dropped content'; else pass 'log never contains dropped content'; fi
if [[ "$LOG" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z ]]; then pass 'log uses ISO UTC time'; else fail 'log uses ISO UTC time'; fi

export FAKE_ITER8_MODE=raw
for BAD in \
  'Review round R0 from ab · 1 note — run `iter8 show R0`' \
  'Review round R01 from ab · 1 note — run `iter8 show R01`' \
  'Review round R1 from a · 1 note — run `iter8 show R1`' \
  'Review round R1 from Ab · 1 note — run `iter8 show R1`' \
  'Review round R1 from abcdefghijklmnopqrstuvwxyzabcdef · 1 note — run `iter8 show R1`' \
  'Review round R1 from ab · 0 notes — run `iter8 show R1`' \
  'Review round R1 from ab · 01 notes — run `iter8 show R1`' \
  'Review round R1 from ab - 1 note — run `iter8 show R1`' \
  'Review round R1 from ab · 1 note - run `iter8 show R1`' \
  'Review round R1 from ab · 1 note — run `iter8 show R1` extra'; do
  export FAKE_ITER8_TEXT="$BAD"$'\n'
  run "$HOOK" prompt
  quiet 'invalid pointer prompt'
  run "$WAKE"
  quiet 'invalid pointer wake'
done
export FAKE_ITER8_TEXT='Review\000 round R12 from larkspur · 7 notes — run `iter8 show R12`'
run "$HOOK" prompt
quiet 'pointer containing NUL on stdout'
run "$WAKE"
quiet 'pointer containing NUL on stderr'
export FAKE_ITER8_TEXT="$POINTER_ONE"
run "$HOOK" prompt
assert_eq "$OUT" "$POINTER_ONE" 'valid final line without newline survives'
export FAKE_ITER8_TEXT='é'
run "$HOOK" prompt
LOG="$(<"$DATA/hooks.log")"
assert_contains "$LOG" 'dropped bytes=2' 'dropped multibyte text logs byte count'
printf '%1048577s' '' > "$DATA/hooks.log"
run "$HOOK" prompt
LOG="$(<"$DATA/hooks.log")"
assert_eq "$(wc -l < "$DATA/hooks.log" | tr -d ' ')" 1 'oversized log is emptied before append'
assert_contains "$LOG" 'dropped bytes=2' 'rotated log retains new entry'

export FAKE_ITER8_MODE=stdout-wake
run "$WAKE"
quiet 'wake pointers on stdout'
run "$HOOK" prompt
quiet 'nonzero prompt with valid stdout'
run "$HOOK" start
quiet 'nonzero start with valid stdout'
run "$HOOK" stop
quiet 'nonzero stop with valid stdout'
export FAKE_ITER8_MODE=silent
run "$WAKE"
quiet 'wake timeout or cancellation'
for ENTRYPOINT in sdk-cli sdk-ts; do
  run env CLAUDE_CODE_ENTRYPOINT="$ENTRYPOINT" "$WAKE"
  quiet "wake under print mode ($ENTRYPOINT)"
  assert_eq "$CALLS" '' "wake under print mode ($ENTRYPOINT) never waits"
done
run env CLAUDE_CODE_ENTRYPOINT=cli "$WAKE"
assert_contains "$CALLS" 'hook	wait' 'wake in an interactive session still waits'
for CODE in 1 4 5 64 127; do
  export FAKE_ITER8_MODE=fail FAKE_ITER8_CODE="$CODE"
  for COMMAND in start prompt stop wake; do
    if [ "$COMMAND" = wake ]; then run "$WAKE"; else run "$HOOK" "$COMMAND"; fi
    quiet "$COMMAND CLI exit $CODE"
    assert_eq "$(printf '%s\n' "$CALLS" | wc -l | tr -d ' ')" 1 "$COMMAND CLI exit $CODE calls only once"
  done
done

SAVED_INPUT="$INPUT"
INPUT='{"session_id":"json label","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"sleep 3"}}'
EXPECTED_SEVEN="$EXPECTED_FIVE"'
Review round R6 from larkspur · 2 notes — run `iter8 show R6`
Review round R7 from larkspur · 2 notes — run `iter8 show R7`'
tool_context() {
  assert_eq "$RC" 0 "$1 tool exits 0"
  assert_eq "$ERR" '' "$1 tool stderr is empty"
  assert_eq "$(printf '%s' "$OUT" | jq -s 'length')" 1 "$1 tool prints one JSON object"
  assert_eq "$(printf '%s' "$OUT" | jq -c '[.hookSpecificOutput | keys[]], (keys)')" $'["additionalContext","hookEventName"]\n["hookSpecificOutput"]' "$1 tool object holds only the hook output"
  assert_eq "$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.hookEventName')" PostToolUse "$1 tool names PostToolUse"
  assert_eq "$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.additionalContext')" "$2" "$1 tool context holds the valid pointers"
}
export FAKE_ITER8_MODE=pointer
run "$HOOK" tool
tool_context pointer "$POINTERS"
assert_eq "$CALLS" $'hook\ttool\t--pid\t4242\tITER8_NO_INSTALL=1' 'tool argv is exact'
export FAKE_ITER8_MODE=toolong
run "$HOOK" tool
tool_context toolong "$EXPECTED_SEVEN"
export FAKE_ITER8_MODE=leak
run "$HOOK" tool
tool_context leak "$POINTER_ONE"
if [[ "$OUT" = *secret* ]]; then fail 'leak tool output contains dropped text'; else pass 'leak tool output never contains dropped text'; fi
for MODE in mismatch plural silent; do
  export FAKE_ITER8_MODE="$MODE"
  run "$HOOK" tool
  quiet "$MODE tool"
done
for CODE in 1 5 69 78; do
  export FAKE_ITER8_MODE=fail FAKE_ITER8_CODE="$CODE"
  run "$HOOK" tool
  quiet "tool CLI exit $CODE"
done
export FAKE_ITER8_MODE=raw FAKE_ITER8_TEXT="$POINTER_ONE"
run "$HOOK" tool
tool_context 'unterminated pointer' "$POINTER_ONE"
export FAKE_ITER8_MODE=pointer
INPUT='{"session_id":"json label","hook_event_name":"PostToolUse","agent_id":"agent-7","agent_type":"Explore"}'
run "$HOOK" tool
quiet 'subagent tool call'
assert_eq "$CALLS" '' 'subagent tool call skips CLI'
INPUT='{"session_id":"json label","hook_event_name":"PostToolUse","agent_type":"reviewer"}'
run "$HOOK" tool
tool_context 'main thread under --agent' "$POINTERS"
INPUT="$SAVED_INPUT"

OWNER_CASE=0
WAIT_CALL=$'hook\twait\t--pid\t4242\t--timeout-seconds\t86100\tITER8_NO_INSTALL=<unset>'
START_CALL=$'hook\tstart\t--pid\t4242\t--label\tsession env label\t--source\tclear\t--agent\tclaude\tITER8_NO_INSTALL=1'
REGISTER_CALLS="$WAIT_CALL"$'\n'"$START_CALL"$'\n'"$WAIT_CALL"
new_owner_case() {
  OWNER_CASE=$((OWNER_CASE + 1))
  export FAKE_ITER8_REGISTERED="$TMP/owner-$OWNER_CASE" FAKE_ITER8_MODE=silent
  unset FAKE_ITER8_START
  INPUT='{"session_id":"json label","source":"clear","hook_event_name":"SessionStart"}'
  : > "$DATA/hooks.log"
}

new_owner_case
run "$WAKE"
quiet 'wake registers a missing owner'
assert_eq "$CALLS" "$REGISTER_CALLS" 'missing owner waits, registers with environment label, then waits once'
if [ -f "$FAKE_ITER8_REGISTERED" ]; then pass 'wake creates the owner'; else fail 'wake creates the owner'; fi
assert_contains "$(<"$DATA/hooks.log")" 'wake owner missing at SessionStart; registering' 'wake logs registration with its event tag'

new_owner_case
export FAKE_ITER8_MODE=pointer
run "$WAKE"
assert_eq "$RC" 2 'registered wake returns 2 for wait pointers'
assert_eq "$OUT" '' 'registered wake pointer stdout is empty'
assert_eq "$ERR" "$POINTERS" 'registered wake relays both wait pointers'
assert_eq "$CALLS" "$REGISTER_CALLS" 'pointer wake waits, registers, then waits once'

new_owner_case
export FAKE_ITER8_START=register-pointer
run "$WAKE"
assert_eq "$RC" 2 'registration pointer returns 2'
assert_eq "$OUT" '' 'registration pointer stdout is empty'
assert_eq "$ERR" "$POINTER_TWO" 'registration relays only its pointer'
assert_eq "$CALLS" "$WAIT_CALL"$'\n'"$START_CALL" 'registration pointer prevents another wait'
if [ -f "$FAKE_ITER8_REGISTERED" ]; then pass 'registration pointer creates the owner'; else fail 'registration pointer creates the owner'; fi
LOG="$(<"$DATA/hooks.log")"
if [[ "$LOG" = *'Review round'* ]] || [[ "$LOG" = *secret* ]]; then fail 'registration log contains pointer or note text'; else pass 'registration log keeps pointer and note text private'; fi

new_owner_case
export FAKE_ITER8_START=fail
run "$WAKE"
quiet 'failed wake registration'
assert_eq "$CALLS" "$WAIT_CALL"$'\n'"$START_CALL" 'failed registration stops after two calls'
assert_contains "$(<"$DATA/hooks.log")" 'wake registration failed with exit 5' 'wake logs registration failure'
if [ ! -e "$FAKE_ITER8_REGISTERED" ]; then pass 'failed registration leaves no owner'; else fail 'failed registration leaves no owner'; fi

new_owner_case
export FAKE_ITER8_START=noop
run "$WAKE"
quiet 'owner still missing after registration'
assert_eq "$CALLS" "$REGISTER_CALLS" 'owner still missing stops after three calls'
assert_contains "$(<"$DATA/hooks.log")" 'wake owner still missing after registration' 'wake logs a missing owner after registration'

for EVENT in UserPromptSubmit Stop; do
  new_owner_case
  INPUT="$(jq -cn --arg event "$EVENT" '{hook_event_name:$event,session_id:"json label",source:"clear"}')"
  run "$WAKE"
  quiet "$EVENT wake with missing owner"
  assert_eq "$CALLS" $'hook\twait\t--pid\t4242\t--timeout-seconds\t86100\tITER8_NO_INSTALL=1' "$EVENT missing owner makes only one wait call"
  assert_contains "$(<"$DATA/hooks.log")" 'wake owner missing outside SessionStart' "$EVENT logs its missing owner"
done

new_owner_case
export CLAUDE_CODE_SESSION_ID=''
INPUT='{"hook_event_name":"SessionStart","source":"clear"}'
run "$WAKE"
quiet 'missing owner without session label'
assert_eq "$CALLS" "$WAIT_CALL" 'missing label prevents registration'
assert_contains "$(<"$DATA/hooks.log")" 'wake session label is missing' 'wake logs a missing label'

new_owner_case
run "$WAKE"
quiet 'wake registration with JSON label'
assert_eq "$CALLS" "$WAIT_CALL"$'\n'$'hook\tstart\t--pid\t4242\t--label\tjson label\t--source\tclear\t--agent\tclaude\tITER8_NO_INSTALL=1'$'\n'"$WAIT_CALL" 'wake falls back to the JSON session label'
export CLAUDE_CODE_SESSION_ID='session env label'

new_owner_case
: > "$FAKE_ITER8_REGISTERED"
run "$WAKE"
quiet 'wake with an existing owner'
assert_eq "$CALLS" "$WAIT_CALL" 'existing owner makes only one wait call'
assert_eq "$(<"$DATA/hooks.log")" '' 'existing owner needs no registration log'

new_owner_case
INPUT='{"session_id":"json label","source":"fork","hook_event_name":"SessionStart"}'
run "$WAKE"
quiet 'wake registration from fork'
assert_eq "$CALLS" "$WAIT_CALL"$'\n'$'hook\tstart\t--pid\t4242\t--label\tsession env label\t--source\tresume\t--agent\tclaude\tITER8_NO_INSTALL=1'$'\n'"$WAIT_CALL" 'wake maps fork to resume when registering'
unset FAKE_ITER8_REGISTERED FAKE_ITER8_START

FIRST_INSTALL="$TMP/first install"
PLUGIN="$FIRST_INSTALL/plugin"
ASSETS="$FIRST_INSTALL/assets"
mkdir -p "$PLUGIN" "$ASSETS" "$FIRST_INSTALL/tools"
cp -R "$ROOT/bin" "$ROOT/scripts" "$PLUGIN/"
cp "$ROOT/tests/fixtures/fake-iter8" "$ASSETS/iter8-linux-x64"
cp "$ROOT/tests/fixtures/fake-iter8" "$ASSETS/iter8-darwin-arm64"
cp "$ROOT/tests/fixtures/fake-gh" "$FIRST_INSTALL/tools/gh"
printf '%s\n' '#!/usr/bin/env bash' 'case "$1" in' '  -s) printf "%s\n" Linux ;;' '  -m) printf "%s\n" x86_64 ;;' '  *) exit 1 ;;' 'esac' > "$FIRST_INSTALL/tools/uname"
chmod 755 "$FIRST_INSTALL/tools/uname"
hash_file() {
  local hash
  if command -v sha256sum >/dev/null 2>&1; then hash="$(sha256sum "$1")"; else hash="$(shasum -a 256 "$1")"; fi
  printf '%s' "${hash%% *}"
}
LINUX_HASH="$(hash_file "$ASSETS/iter8-linux-x64")"
DARWIN_HASH="$(hash_file "$ASSETS/iter8-darwin-arm64")"
printf '%s  iter8-linux-x64\n%s  iter8-darwin-arm64\n' "$LINUX_HASH" "$DARWIN_HASH" > "$ASSETS/SHA256SUMS"
jq -n --arg linux "$LINUX_HASH" --arg darwin "$DARWIN_HASH" '{version:"9.9.9",sha256:{"iter8-linux-x64":$linux,"iter8-darwin-arm64":$darwin}}' > "$PLUGIN/release.json"
export ITER8_PLUGIN_DATA="$FIRST_INSTALL/data" FAKE_ITER8_REGISTERED="$FIRST_INSTALL/owner" FAKE_ITER8_MODE=silent
export FAKE_GH_ASSETS="$ASSETS" FAKE_GH_LOG="$FIRST_INSTALL/gh.log"
unset ITER8_BIN ITER8_NO_INSTALL FAKE_GH_AUTH FAKE_GH_DELAY FAKE_GH_DOWNLOAD
TEST_PATH="$FIRST_INSTALL/tools:$TMP/tools:$PATH"
INPUT='{"session_id":"json label","source":"clear","hook_event_name":"SessionStart"}'
INSTALLED="$ITER8_PLUGIN_DATA/releases/v9.9.9/iter8"
run "$PLUGIN/scripts/hook.sh" start
quiet 'start before the first install'
assert_eq "$CALLS" '' 'start before install never executes the release binary'
if [ ! -e "$INSTALLED" ]; then pass 'start leaves the first installation to wake'; else fail 'start leaves the first installation to wake'; fi
run "$PLUGIN/scripts/wake.sh"
quiet 'wake after the first uninstalled start'
if [ -x "$INSTALLED" ]; then pass 'wake installs the pinned binary'; else fail 'wake installs the pinned binary'; fi
assert_eq "$CALLS" "$REGISTER_CALLS" 'first installed wake waits, registers, then waits with exact flags'
if [ -f "$FAKE_ITER8_REGISTERED" ]; then pass 'first installed wake creates the owner'; else fail 'first installed wake creates the owner'; fi
assert_contains "$(<"$ITER8_PLUGIN_DATA/hooks.log")" 'wake owner missing at SessionStart; registering' 'first installed wake logs registration'
unset ITER8_PLUGIN_DATA FAKE_ITER8_REGISTERED FAKE_GH_ASSETS FAKE_GH_LOG
export ITER8_BIN="$ROOT/tests/fixtures/fake-iter8"
TEST_PATH="$TMP/tools:$PATH"

INPUT='{"hook_event_name":"SessionEnd","session_id":"json end","reason":"clear"}'
export FAKE_ITER8_MODE=sleep FAKE_ITER8_SLEEP=3
SECONDS=0
run "$HOOK" end
ELAPSED="$SECONDS"
quiet 'detached end'
assert_eq "$ELAPSED" 0 'end returns within one second against a three-second CLI'
assert_eq "$CALLS" '' 'sleeping end has not recorded when hook returns'
await_end
assert_eq "$CALLS" $'hook\tend\t--pid\t4242\t--label\tsession env label\t--reason\tclear\tITER8_NO_INSTALL=1' 'detached end still completes with exact argv'
export FAKE_ITER8_MODE=silent CLAUDE_CODE_SESSION_ID=''
for REASON in clear resume logout prompt_input_exit other unknown ''; do
  INPUT="$(jq -cn --arg reason "$REASON" '{session_id:"json end",reason:$reason}')"
  case "$REASON" in unknown|'') MAPPED=other ;; *) MAPPED="$REASON" ;; esac
  run "$HOOK" end
  quiet "end reason '$REASON'"
  await_end
  assert_eq "$CALLS" "$(printf 'hook\tend\t--pid\t4242\t--label\tjson end\t--reason\t%s\tITER8_NO_INSTALL=1' "$MAPPED")" "end maps '$REASON' to $MAPPED and uses fallback label"
done
INPUT='{}'
for COMMAND in start end; do
  run "$HOOK" "$COMMAND"
  quiet "$COMMAND without label"
  assert_eq "$CALLS" '' "$COMMAND without label skips CLI"
done
export CLAUDE_CODE_SESSION_ID=label
printf '%s\n' "$$ 4101 /bin/sh" '4101 4102 /bin/bash' '4102 4103 -zsh' '4103 4104 dash' '4104 4105 ksh' '4105 4106 fish' '4106 4107 sh' '4107 4242 bash' '4242 1 bun' > "$FAKE_PS_TABLE"
for COMMAND in start prompt tool stop end wake; do
  if [ "$COMMAND" = wake ]; then run "$WAKE"; else run "$HOOK" "$COMMAND"; fi
  quiet "$COMMAND with eight shell ancestors"
  assert_eq "$CALLS" '' "$COMMAND ancestry is capped at eight"
done
printf '%s\n' "$$ 4101 sh" '4101 4102 bash' '4102 4103 zsh' '4103 4104 dash' '4104 4105 ksh' '4105 4106 fish' '4106 4242 sh' '4242 1 bun' > "$FAKE_PS_TABLE"
run "$HOOK" prompt
assert_eq "$CALLS" $'hook\tprompt\t--pid\t4242\tITER8_NO_INSTALL=1' 'eighth ancestor can be non-shell and bun is accepted'
: > "$FAKE_PS_TABLE"
run "$HOOK" prompt
quiet 'missing process table entry'
assert_eq "$CALLS" '' 'missing process skips CLI'
normal_ancestry

unset ITER8_BIN
printf '%s\n%s\n' 'gh authentication failed' 'second line must stay private' > "$DATA/install-error"
run "$HOOK" start
assert_eq "$RC" 0 'missing pinned release exits 0'
assert_eq "$OUT" 'iter8 is not installed: gh authentication failed' 'missing release reports only first install-error line'
assert_eq "$ERR" '' 'missing release suppresses launcher stderr'
run "$WAKE"
quiet 'missing binary wake'
unlink "$DATA/install-error"
run "$HOOK" start
quiet 'missing binary without install-error'
export ITER8_BIN="$ROOT/tests/fixtures/fake-iter8" FAKE_ITER8_MODE=fail FAKE_ITER8_CODE=69
printf '%s\n' 'pinned binary is missing' > "$DATA/install-error"
run "$HOOK" start
assert_eq "$OUT" 'iter8 is not installed: pinned binary is missing' 'launcher exit 69 reports saved error'
unlink "$DATA/install-error"
run "$HOOK" start
quiet 'launcher exit 69 without saved error'
export ITER8_BIN="$TMP/nonexistent"
run "$HOOK" start
quiet 'invalid executable override start'
run "$WAKE"
quiet 'invalid executable override wake'
export ITER8_BIN="$ROOT/tests/fixtures/fake-iter8" FAKE_ITER8_MODE=pointer
TEST_PATH="$TMP/no-jq"
run "$HOOK" start
assert_eq "$RC" 0 'missing jq start exits 0'
assert_eq "$OUT" 'iter8 hooks are off: jq is not installed.' 'missing jq start explains hooks are off'
assert_eq "$ERR" '' 'missing jq start stderr is empty'
assert_eq "$CALLS" '' 'missing jq start skips CLI'
for COMMAND in prompt tool stop end wake; do
  if [ "$COMMAND" = wake ]; then run "$WAKE"; else run "$HOOK" "$COMMAND"; fi
  quiet "$COMMAND without jq"
  assert_eq "$CALLS" '' "$COMMAND without jq skips CLI"
done
TEST_PATH="$TMP/tools:$PATH"
export ITER8_PLUGIN_DATA="$TMP/override-data" FAKE_ITER8_MODE=mismatch
run "$HOOK" prompt
if [ -f "$ITER8_PLUGIN_DATA/hooks.log" ]; then pass 'explicit data directory holds hook log'; else fail 'explicit data directory holds hook log'; fi
assert_eq "$(find "$TMP" -name 'hook-output.*' -o -name 'wake-errors.*' -o -name 'wake-start.*')" '' 'hook temporary files are cleaned'

WIRING="$(jq -r '.hooks | to_entries[] | .key as $event | .value[].hooks[] | [$event, .command, (.timeout|tostring), (.async // false|tostring), (.asyncRewake // false|tostring)] | @tsv' "$ROOT/hooks/hooks.json")"
EXPECTED_WIRING='SessionStart\t"${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh" start\t10\tfalse\tfalse
SessionStart\t"${CLAUDE_PLUGIN_ROOT}/scripts/wake.sh"\t86400\ttrue\ttrue
UserPromptSubmit\t"${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh" prompt\t5\tfalse\tfalse
UserPromptSubmit\t"${CLAUDE_PLUGIN_ROOT}/scripts/wake.sh"\t86400\ttrue\ttrue
PostToolUse\t"${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh" tool\t5\tfalse\tfalse
Stop\t"${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh" stop\t5\tfalse\tfalse
Stop\t"${CLAUDE_PLUGIN_ROOT}/scripts/wake.sh"\t86400\ttrue\ttrue
SessionEnd\t"${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh" end\t2\tfalse\tfalse'
assert_eq "$WIRING" "$(printf '%b' "$EXPECTED_WIRING")" 'hook table matches every event, command, timeout, async flag and wake mode'
assert_eq "$(jq '[.hooks[][] | has("matcher")] | any' "$ROOT/hooks/hooks.json")" false 'hook table has no matchers'
assert_eq "$(jq '[.hooks[][].hooks[] | select(.type == "command") | has("timeout")] | all' "$ROOT/hooks/hooks.json")" true 'every command has explicit timeout'
assert_eq "$(jq --argjson seconds "$WAIT_SECONDS" '[.hooks[][].hooks[] | select(.asyncRewake == true) | .timeout == 86400 and .timeout > $seconds] | length == 3 and all' "$ROOT/hooks/hooks.json")" true 'three wake timeouts exceed recorded CLI deadline'
assert_eq "$(jq -r '[.hooks[][].hooks[] | select(has("statusMessage")) | .command] | join("\n")' "$ROOT/hooks/hooks.json")" '"${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh" start' 'only sync start declares statusMessage'
assert_eq "$(jq 'has("description") and has("hooks")' "$ROOT/hooks/hooks.json")" true 'hook configuration has description and wrapper'
unset FAKE_ITER8_TEXT ITER8_PLUGIN_DATA
for EVENT_NAME in prompt tool stop; do
  : > "$DATA/hooks.log"
  export FAKE_ITER8_MODE=silent
  run "$HOOK" "$EVENT_NAME"
  assert_eq "$(<"$DATA/hooks.log")" '' "a fast successful $EVENT_NAME hook logs nothing"
  export FAKE_ITER8_MODE=fail FAKE_ITER8_CODE=5
  run "$HOOK" "$EVENT_NAME"
  assert_eq "$(<"$DATA/hooks.log")" '' "a $EVENT_NAME hook finding no service logs nothing"
  export FAKE_ITER8_CODE=1
  run "$HOOK" "$EVENT_NAME"
  assert_contains "$(<"$DATA/hooks.log")" "$EVENT_NAME exit=1 seconds=" "a failing $EVENT_NAME hook logs its exit code"
  assert_contains "$(<"$DATA/hooks.log")" "reason=Review round R12 from larkspur" "a failing $EVENT_NAME hook logs the first line the CLI wrote to stderr"
  : > "$DATA/hooks.log"
  export FAKE_ITER8_MODE=sleep FAKE_ITER8_SLEEP=2
  run "$HOOK" "$EVENT_NAME"
  assert_contains "$(<"$DATA/hooks.log")" "$EVENT_NAME exit=0 seconds=" "a slow $EVENT_NAME hook logs its duration"
done
unset FAKE_ITER8_MODE FAKE_ITER8_CODE FAKE_ITER8_SLEEP
printf '\niter8 hooks: %s passed, %s failed\n' "$PASS" "$FAIL"
exit "$FAIL"

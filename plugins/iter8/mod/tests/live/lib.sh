#!/usr/bin/env bash

LIVE_MIN_VERSION=2.1.296

live_require() {
  local version major minor patch auth tool
  command -v claude >/dev/null 2>&1 || { echo "SKIP live: Claude Code >= $LIVE_MIN_VERSION is required" >&2; exit 77; }
  version=$(claude --version 2>/dev/null) || version=''
  if [[ $version =~ ([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
    major=$((10#${BASH_REMATCH[1]})); minor=$((10#${BASH_REMATCH[2]})); patch=$((10#${BASH_REMATCH[3]}))
    if (( major < 2 || (major == 2 && minor < 1) || (major == 2 && minor == 1 && patch < 296) )); then
      printf 'SKIP live: Claude Code >= %s is required (found %s)\n' "$LIVE_MIN_VERSION" "$version" >&2
      exit 77
    fi
  else
    echo "SKIP live: cannot determine Claude Code version; >= $LIVE_MIN_VERSION is required" >&2
    exit 77
  fi
  for tool in tmux jq python3; do
    command -v "$tool" >/dev/null 2>&1 || { printf 'SKIP live: %s is required\n' "$tool" >&2; exit 77; }
  done
  auth=$(claude auth status --json 2>/dev/null) || auth='{}'
  if ! jq -e '.loggedIn == true' >/dev/null 2>&1 <<< "$auth"; then
    echo 'SKIP live: Claude Code is not signed in; run claude auth login' >&2
    exit 77
  fi
}

# Copies the manifest and the bin, hooks, mod and scripts trees only: loading a plugin
# writes .claude-plugin/types beside it, and that must stay in the copy.
live_plugin() {
  local source=$1 dest=$2 part
  [[ -f $source/.claude-plugin/plugin.json ]] || { printf 'live_plugin: no plugin at %s\n' "$source" >&2; return 1; }
  [[ ! -e $dest ]] || { printf 'live_plugin: destination already exists: %s\n' "$dest" >&2; return 1; }
  mkdir -p -- "$dest/.claude-plugin" || return
  LIVE_PLUGIN=$(cd -- "$dest" && pwd)
  cp -- "$source/.claude-plugin/plugin.json" "$LIVE_PLUGIN/.claude-plugin/plugin.json" || return
  for part in bin hooks mod scripts; do
    [[ ! -d $source/$part ]] || cp -R -- "$source/$part" "$LIVE_PLUGIN/$part" || return
  done
  export LIVE_PLUGIN
}

# An isolated CLAUDE_CONFIG_DIR: copied credentials, the fullscreen renderer, and an
# optional JSON object of further settings merged over those.
live_config() {
  local dest=$1 extra=${2:-} source=${CLAUDE_CONFIG_DIR:-$HOME/.claude} global
  [[ -n $extra ]] || extra='{}'
  [[ ! -e $dest ]] || { printf 'live_config: destination already exists: %s\n' "$dest" >&2; return 1; }
  jq -e 'type == "object"' >/dev/null 2>&1 <<< "$extra" || { echo 'live_config: settings must be a JSON object' >&2; return 1; }
  (umask 077 && mkdir -p -- "$dest") || return
  if [[ -f $source/.credentials.json ]]; then
    (umask 077 && cp -- "$source/.credentials.json" "$dest/.credentials.json") || return
  fi
  # A config dir without the person's recorded consent to managed settings opens an approval dialog at startup.
  for global in remote-settings-consent.json remote-settings.json; do
    if [[ -f $source/$global ]]; then
      (umask 077 && cp -- "$source/$global" "$dest/$global") || return
    fi
  done
  global=$source/.claude.json
  [[ -f $global ]] || global=$HOME/.claude.json
  if [[ -f $global ]]; then
    (umask 077 && cp -- "$global" "$dest/.claude.json") || return
  fi
  jq -n --argjson extra "$extra" '{tui: "fullscreen"} + $extra' > "$dest/settings.json"
}

live_tmux_start() {
  local name=$1
  shift
  [[ $name =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'live_tmux_start: use a name containing letters, numbers, underscores or hyphens' >&2; return 1; }
  [[ -d ${LIVE_ROOT:-} ]] || { echo 'live_tmux_start: set LIVE_ROOT to an existing directory' >&2; return 1; }
  LIVE_SOCKET="$LIVE_ROOT/tmux.sock"
  LIVE_SESSION=$name
  LIVE_PANE=$(tmux -f /dev/null -S "$LIVE_SOCKET" new-session -d -P -F '#{pane_id}' -s "$name" \
    -x "${LIVE_WIDTH:-180}" -y "${LIVE_HEIGHT:-50}" -c "$LIVE_ROOT") || return
  # Keeps the pane, and what it printed, when the command exits during startup.
  tmux -S "$LIVE_SOCKET" set-option -t "$name" remain-on-exit on || return
  tmux -S "$LIVE_SOCKET" respawn-pane -k -t "$LIVE_PANE" -c "${LIVE_CWD:-$LIVE_ROOT}" "exec $*" || return
  export LIVE_SOCKET LIVE_SESSION LIVE_PANE
}

# Starts Claude Code with the plugin in LIVE_PLUGIN, in LIVE_REPO under LIVE_CONFIG, and
# returns once the prompt is showing. Extra arguments are passed to claude; LIVE_CONFIG_EXTRA
# is the JSON object live_config merges into settings; LIVE_PASS_ENV names variables, set in
# this shell, that Claude Code and its hooks receive.
live_session() {
  local name=$1 command screen started var
  local -a pass=()
  shift
  for var in ${LIVE_PASS_ENV:-}; do
    [[ $var =~ ^[A-Za-z_][A-Za-z0-9_]*$ && -n ${!var+x} ]] || { printf 'live_session: %s is not a set variable\n' "$var" >&2; return 1; }
    pass+=("$var=${!var}")
  done
  [[ -d ${LIVE_PLUGIN:-} ]] || { echo 'live_session: call live_plugin first' >&2; return 1; }
  LIVE_ROOT=${LIVE_ROOT:-$(mktemp -d /tmp/iter8-live.XXXXXX)}
  mkdir -p -- "$LIVE_ROOT" || return
  LIVE_ROOT=$(cd -- "$LIVE_ROOT" && pwd)
  LIVE_REPO="$LIVE_ROOT/project"
  LIVE_CONFIG="$LIVE_ROOT/config"
  mkdir -p -- "$LIVE_REPO/.claude" || return
  live_config "$LIVE_CONFIG" "${LIVE_CONFIG_EXTRA:-}" || return
  export LIVE_ROOT LIVE_REPO LIVE_CONFIG
  printf -v command '%q ' env -u CLAUDECODE -u CLAUDE_CODE_PLUGIN_DIRS \
    "CLAUDE_CONFIG_DIR=$LIVE_CONFIG" CLAUDE_CODE_NO_FLICKER=1 ${pass[@]+"${pass[@]}"} \
    claude "$@" --setting-sources user,project,local --plugin-dir "$LIVE_PLUGIN" --model haiku \
    --strict-mcp-config
  LIVE_CWD=$LIVE_REPO live_tmux_start "$name" "$command" || return
  started=$SECONDS
  while (( SECONDS - started < 60 )); do
    screen=$(live_screen) || return
    if [[ $(tmux -S "$LIVE_SOCKET" display-message -p -t "$LIVE_PANE" '#{pane_dead}') == 1 ]]; then
      printf 'live_session: Claude exited during startup\n%s\n' "$screen" >&2
      return 1
    fi
    if [[ $screen =~ (Select login method|Please run /login|Not logged in) ]]; then
      printf 'SKIP live: the isolated config is not signed in; its credentials are not in %s/.credentials.json\n' \
        "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" >&2
      live_stop
      exit 77
    elif [[ $screen == *'Yes, I trust this folder'* || $screen == *'Yes, I accept'* ]]; then
      tmux -S "$LIVE_SOCKET" send-keys -t "$LIVE_PANE" Down Enter || return
    elif live_parse_prompt_row <<< "$screen" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  printf 'live_session: Claude did not reach its prompt within 60 seconds\n%s\n' "$screen" >&2
  return 1
}

# An Enter right behind a burst of text can land inside the paste window and be swallowed.
live_send() {
  tmux -S "$LIVE_SOCKET" send-keys -t "$LIVE_PANE" -l -- "$*" || return
  sleep 0.5
  tmux -S "$LIVE_SOCKET" send-keys -t "$LIVE_PANE" Enter
}

live_key() {
  tmux -S "$LIVE_SOCKET" send-keys -t "$LIVE_PANE" "$@"
}

live_capture() {
  tmux -S "$LIVE_SOCKET" capture-pane -p -S - -t "$LIVE_PANE"
}

live_screen() {
  tmux -S "$LIVE_SOCKET" capture-pane -p -t "$LIVE_PANE"
}

live_wait_for() {
  local pattern=$1 timeout=$2 started=$SECONDS screen
  [[ $timeout =~ ^[0-9]+$ ]] || { echo 'live_wait_for: timeout must be nonnegative seconds' >&2; return 2; }
  timeout=$((10#$timeout))
  while :; do
    screen=$(live_screen) || return
    if printf '%s\n' "$screen" | grep -Eq -- "$pattern"; then return 0; fi
    (( SECONDS - started < timeout )) || break
    sleep 0.5
  done
  printf 'live_wait_for: timed out after %s seconds waiting for %s\n' "$timeout" "$pattern" >&2
  return 1
}

# Polls a command until it succeeds: live_wait_until <seconds> <what> <command...>.
live_wait_until() {
  local timeout=$1 what=$2 started=$SECONDS
  shift 2
  [[ $timeout =~ ^[0-9]+$ ]] || { echo 'live_wait_until: timeout must be nonnegative seconds' >&2; return 2; }
  timeout=$((10#$timeout))
  while :; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    (( SECONDS - started < timeout )) || break
    sleep 0.5
  done
  printf 'live_wait_until: timed out after %s seconds waiting for %s\n' "$timeout" "$what" >&2
  return 1
}

# The prompt is the last row opening with ❯; the transcript's own ❯ rows sit above it.
live_parse_prompt_row() {
  LC_ALL=C awk '/^❯/ { row = NR } END { if (row == "") exit 1; print row }'
}

# The newest session transcript under LIVE_CONFIG; empty and failing when there is none.
live_transcript() {
  local file newest=''
  for file in "$LIVE_CONFIG"/projects/*/*.jsonl; do
    [[ -f $file ]] || continue
    if [[ -z $newest || $file -nt $newest ]]; then newest=$file; fi
  done
  [[ -n $newest ]] || return 1
  printf '%s\n' "$newest"
}

live_stop() {
  if [[ -n ${LIVE_SOCKET:-} && -S $LIVE_SOCKET ]]; then
    tmux -S "$LIVE_SOCKET" kill-server 2>/dev/null || true
  fi
  unset LIVE_SESSION LIVE_PANE LIVE_SOCKET
}

#!/usr/bin/env bash

iter8_data_dir() {
  printf '%s\n' "${ITER8_PLUGIN_DATA:-${XDG_DATA_HOME:-$HOME/.local/share}/iter8-claude-plugin}"
}

iter8_log() {
  local data log size
  data="$(iter8_data_dir)"
  mkdir -p "$data" 2>/dev/null || return 0
  log="$data/hooks.log"
  if [ -f "$log" ]; then
    size="$(wc -c < "$log" 2>/dev/null)"
    if [ "${size:-0}" -gt 1048576 ]; then
      : > "$log" 2>/dev/null || return 0
    fi
  fi
  printf '%s %s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" "$1" "$2" >> "$log" 2>/dev/null || :
}

agent_pid() {
  local pid comm step
  pid="$PPID"
  step=0
  while [ "$step" -lt 8 ] && [[ "$pid" =~ ^[1-9][0-9]*$ ]]; do
    comm="$(ps -o comm= -p "$pid" 2>/dev/null)" || return 0
    read -r comm <<< "$comm"
    [ -n "$comm" ] || return 0
    comm="${comm##*/}"
    comm="${comm#-}"
    case "$comm" in
      sh|bash|zsh|dash|ksh|fish) ;;
      *) printf '%s\n' "$pid"; return 0 ;;
    esac
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null)" || return 0
    read -r pid <<< "$pid"
    step=$((step + 1))
  done
}

filter_pointers() {
  local LC_ALL=C line count pattern cap="${1:-5}"
  count=0
  pattern='^Review round (R[1-9][0-9]*) from ([a-z][a-z0-9-]{1,30}) · ([1-9][0-9]*) (notes?) — run `iter8 show (R[1-9][0-9]*)`$'
  # Bash read discards NUL bytes; preserve their length with a byte the grammar rejects.
  LC_ALL=C tr '\000' '\001' | while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ $pattern ]] &&
       [ "${BASH_REMATCH[5]}" = "${BASH_REMATCH[1]}" ] &&
       { { [ "${BASH_REMATCH[3]}" = 1 ] && [ "${BASH_REMATCH[4]}" = note ]; } ||
         { [ "${BASH_REMATCH[3]}" != 1 ] && [ "${BASH_REMATCH[4]}" = notes ]; }; } &&
       { [ "$cap" = none ] || [ "$count" -lt "$cap" ]; }; then
      printf '%s\n' "$line"
      count=$((count + 1))
    else
      iter8_log dropped "bytes=${#line}"
    fi
  done
}

hook_input_field() {
  printf '%s' "$HOOK_INPUT" | jq -r --arg name "$1" '.[$name] | if type == "string" then . else empty end' 2>/dev/null
}

map_source() {
  case "$1" in
    fork) printf '%s\n' resume ;;
    startup|resume|clear|compact) printf '%s\n' "$1" ;;
    *) printf '%s\n' startup ;;
  esac
}

ITER8_SEMVER='^([0-9]+)\.([0-9]+)\.([0-9]+)(-([0-9A-Za-z.-]+))?(\+[0-9A-Za-z.-]+)?$'

# Sets ITER8_CMP to -1, 0 or 1; builtins only, because the launcher calls it on every hook.
# Build metadata is ignored and a prerelease sorts below its release, as in iter8's own compareVersions.
iter8_semver_cmp() {
  local LC_ALL=C IFS=. i x y apre bpre
  local -a acore bcore apart bpart
  [[ "$1" =~ $ITER8_SEMVER ]] || return 1
  # bash 3.2 joins an array slice into one word when IFS is not the default.
  acore=("${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}")
  apre="${BASH_REMATCH[5]}"
  [[ "$2" =~ $ITER8_SEMVER ]] || return 1
  bcore=("${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}")
  bpre="${BASH_REMATCH[5]}"
  for i in 0 1 2; do
    if (( 10#${acore[i]} != 10#${bcore[i]} )); then
      if (( 10#${acore[i]} < 10#${bcore[i]} )); then ITER8_CMP=-1; else ITER8_CMP=1; fi
      return 0
    fi
  done
  ITER8_CMP=0
  [ "$apre" != "$bpre" ] || return 0
  if [ -z "$apre" ]; then ITER8_CMP=1; return 0; fi
  if [ -z "$bpre" ]; then ITER8_CMP=-1; return 0; fi
  apart=($apre)
  bpart=($bpre)
  for (( i = 0; i < ${#apart[@]} && i < ${#bpart[@]}; i++ )); do
    x="${apart[i]}"
    y="${bpart[i]}"
    [ "$x" != "$y" ] || continue
    if [[ "$x" =~ ^[0-9]+$ && "$y" =~ ^[0-9]+$ ]]; then
      (( 10#$x != 10#$y )) || continue
      if (( 10#$x < 10#$y )); then ITER8_CMP=-1; else ITER8_CMP=1; fi
    elif [[ "$x" =~ ^[0-9]+$ ]]; then
      ITER8_CMP=-1
    elif [[ "$y" =~ ^[0-9]+$ ]]; then
      ITER8_CMP=1
    elif [[ "$x" < "$y" ]]; then
      ITER8_CMP=-1
    else
      ITER8_CMP=1
    fi
    return 0
  done
  if (( ${#apart[@]} < ${#bpart[@]} )); then ITER8_CMP=-1; elif (( ${#apart[@]} > ${#bpart[@]} )); then ITER8_CMP=1; fi
}

# Sets ITER8_NEWEST_VERSION and ITER8_NEWEST_BIN to the newest executable release under $1 whose
# version is at least $2; both are empty when there is none. Directories that are not a valid
# version are skipped.
iter8_newest_release() {
  local bin version floor="${2:-}"
  ITER8_NEWEST_VERSION=""
  ITER8_NEWEST_BIN=""
  for bin in "$1"/releases/v*/iter8; do
    [ -f "$bin" ] && [ -x "$bin" ] || continue
    version="${bin%/iter8}"
    version="${version##*/}"
    version="${version#v}"
    [[ "$version" =~ $ITER8_SEMVER ]] || continue
    if [ -n "$floor" ]; then
      iter8_semver_cmp "$version" "$floor" || continue
      [ "$ITER8_CMP" -ge 0 ] || continue
    fi
    if [ -n "$ITER8_NEWEST_VERSION" ]; then
      iter8_semver_cmp "$version" "$ITER8_NEWEST_VERSION" || continue
      [ "$ITER8_CMP" -gt 0 ] || continue
    fi
    ITER8_NEWEST_VERSION="$version"
    ITER8_NEWEST_BIN="$bin"
  done
}

#!/usr/bin/env bash
set -uo pipefail

MOD_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PLUGIN_DIR="$(cd "$MOD_DIR/.." && pwd -P)"
ONLY=()

usage() { echo "Usage: $0 [--only <test file>]..." >&2; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --only)
      if [ "$#" -lt 2 ] || [ ! -f "$2" ] || [[ "$2" != *.test.ts ]]; then
        usage; exit 2
      fi
      TEST_DIR=$(cd "$(dirname "$2")" && pwd -P) || exit 2
      TEST_PATH="$TEST_DIR/$(basename "$2")"
      case "$TEST_PATH" in
        "$MOD_DIR"/*) ONLY+=("${TEST_PATH#"$MOD_DIR"/}") ;;
        *) echo "Test file must be under $MOD_DIR: $2" >&2; exit 2 ;;
      esac
      shift 2
      ;;
    *) usage; exit 2 ;;
  esac
done

TESTS=()
while IFS= read -r -d '' TEST_PATH; do
  TESTS+=("$TEST_PATH")
done < <(find "$MOD_DIR" \( -path "$MOD_DIR/experiments" -o -path "$MOD_DIR/tests/live" \) -prune -o -type f -name '*.test.ts' -print0)

if [ "${#TESTS[@]}" -eq 0 ]; then
  echo 'No mod tests found.'
  exit 0
fi

# Retain the copy: the generated declarations under .claude-plugin/types are read from it.
TEST_PLUGIN=$(mktemp -d "${TMPDIR:-/tmp}/iter8-mod-tests.XXXXXX") || exit 1
echo "Test plugin: $TEST_PLUGIN"
for COMPONENT in .claude-plugin hooks mod; do
  if [ -e "$PLUGIN_DIR/$COMPONENT" ]; then
    cp -RL "$PLUGIN_DIR/$COMPONENT" "$TEST_PLUGIN/$COMPONENT" || exit 1
  fi
done

while IFS= read -r -d '' TEST_PATH; do
  KEEP=false
  if [[ "$TEST_PATH" == "$TEST_PLUGIN/mod/"*.test.ts ]]; then
    RELATIVE="${TEST_PATH#"$TEST_PLUGIN/mod/"}"
    if [ "${#ONLY[@]}" -eq 0 ]; then
      # Probe and live tests need a scratch plugin or a running service; select one with --only.
      case "$RELATIVE" in
        experiments/*|tests/live/*) ;;
        *) KEEP=true ;;
      esac
    else
      for SELECTED in "${ONLY[@]}"; do
        if [ "$RELATIVE" = "$SELECTED" ]; then KEEP=true; break; fi
      done
    fi
  fi
  if [ "$KEEP" = false ]; then rm -- "$TEST_PATH" || exit 1; fi
done < <(find "$TEST_PLUGIN" -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -print0)

mkdir -p "$TEST_PLUGIN/hooks" || exit 1
if ! grep -q '"modules"' "$TEST_PLUGIN/hooks/hooks.json" 2>/dev/null; then
  printf '%s\n' '{"modules":["./noop.ts"]}' > "$TEST_PLUGIN/hooks/hooks.json" || exit 1
  printf '%s\n' 'export function register() {}' > "$TEST_PLUGIN/hooks/noop.ts" || exit 1
fi

claude plugin test "$TEST_PLUGIN"
exit "$?"

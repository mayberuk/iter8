#!/usr/bin/env bash
set -uo pipefail

SELF="${BASH_SOURCE[0]}"
DIR="${SELF%/*}"
[ "$DIR" = "$SELF" ] && DIR="."
DIR="$(cd -- "$DIR" && pwd)"
TOTAL_FAIL=0

for test_script in "$DIR/install.sh" "$DIR/hooks.sh" "$DIR/rounds-skill.sh"; do
  if [ -f "$test_script" ]; then
    echo ""
    bash "$test_script"
    TOTAL_FAIL=$((TOTAL_FAIL + $?))
  else
    echo "SKIP: ${test_script##*/} not found"
  fi
done

echo ""
if [ "$TOTAL_FAIL" -eq 0 ]; then
  echo 'All iter8 suites passed.'
else
  echo "$TOTAL_FAIL failure(s)."
fi
exit "$TOTAL_FAIL"

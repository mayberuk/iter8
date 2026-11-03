#!/usr/bin/env bash
set -uo pipefail

SELF="${BASH_SOURCE[0]}"
SELF_DIR="${SELF%/*}"
[ "$SELF_DIR" = "$SELF" ] && SELF_DIR="."
ROOT="$(cd -- "$SELF_DIR/.." && pwd)"
DATA="${ITER8_PLUGIN_DATA:-${XDG_DATA_HOME:-$HOME/.local/share}/iter8-claude-plugin}"
. "$ROOT/scripts/lib.sh"
TEMP=""
LOCK=""
LOCK_HELD=0

remove_file() { [ ! -e "$1" ] || unlink "$1"; }
fail() {
  printf 'iter8: %s\n' "$2" >&2
  mkdir -p "$DATA" 2>/dev/null && printf '%s\n' "$2" > "$DATA/install-error"
  exit "$1"
}
point_current() {
  local link="$DATA/current" target pointed staging
  iter8_newest_release "$DATA"
  [ -n "$ITER8_NEWEST_BIN" ] || return 0
  if target="$(readlink "$link" 2>/dev/null)" && [[ "$target" =~ (^|/)releases/v([^/]+)/iter8$ ]]; then
    pointed="${BASH_REMATCH[2]}"
    if [ -x "$link" ] && iter8_semver_cmp "$pointed" "$ITER8_NEWEST_VERSION" && [ "$ITER8_CMP" -ge 0 ]; then
      return 0
    fi
  fi
  staging="$link.$$"
  { ln -s "$ITER8_NEWEST_BIN" "$staging" && mv -f "$staging" "$link"; } 2>/dev/null || {
    remove_file "$staging"
    fail 76 "cannot point $link at $ITER8_NEWEST_BIN"
  }
}
cleanup() {
  if [ -n "$TEMP" ]; then
    remove_file "$TEMP/$ASSET"
    remove_file "$TEMP/SHA256SUMS"
    rmdir "$TEMP" 2>/dev/null || :
  fi
  if [ "$LOCK_HELD" -eq 1 ]; then
    remove_file "$LOCK/pid"
    rmdir "$LOCK" 2>/dev/null || :
  fi
}
trap cleanup EXIT
trap 'fail 76 "installation interrupted"' HUP INT TERM

command -v jq >/dev/null 2>&1 || fail 78 'cannot read the release pin — install jq, then run scripts/pin-release.sh <version>'
VERSION="$(jq -er '.version | select(type == "string")' "$ROOT/release.json" 2>/dev/null)" || fail 78 'no iter8 release is pinned yet — run scripts/pin-release.sh <version>'
VERSION_FORMAT='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
[[ "$VERSION" =~ $VERSION_FORMAT ]] || fail 78 'no valid iter8 release is pinned — run scripts/pin-release.sh <version>'

REPO="$(jq -er '.repo | select(type == "string") | select(test("^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$"))' "$ROOT/release.json" 2>/dev/null)" || fail 78 'release.json has no valid repo'

SYSTEM="$(uname -s)" || fail 71 'cannot detect platform; supported platforms are linux-x64 and darwin-arm64'
MACHINE="$(uname -m)" || fail 71 'cannot detect platform; supported platforms are linux-x64 and darwin-arm64'
case "$SYSTEM/$MACHINE" in
  Linux/x86_64) PLATFORM=linux-x64 ;;
  Darwin/arm64) PLATFORM=darwin-arm64 ;;
  *) fail 71 "unsupported platform $SYSTEM/$MACHINE; supported platforms are linux-x64 and darwin-arm64" ;;
esac
ASSET="iter8-$PLATFORM"
PIN="$(jq -er --arg asset "$ASSET" '.sha256[$asset] | select(type == "string") | select(test("^[0-9a-fA-F]{64}$")) | ascii_downcase' "$ROOT/release.json" 2>/dev/null)" || fail 78 'no checksum is pinned — run scripts/pin-release.sh <version>'
RELEASE_DIR="$DATA/releases/v$VERSION"
BIN="$RELEASE_DIR/iter8"
[ ! -d "$BIN" ] || fail 76 "install path is a directory: $BIN"
mkdir -p "$RELEASE_DIR" || fail 76 "cannot create release directory $RELEASE_DIR"
LOCK="$RELEASE_DIR/.lock"
POLL=0
while ! mkdir "$LOCK" 2>/dev/null; do
  # A second reaper must not remove a lock just acquired after stale cleanup.
  if mkdir "$LOCK.reap" 2>/dev/null; then
    PID=""
    [ ! -r "$LOCK/pid" ] || PID="$(<"$LOCK/pid")"
    if [[ "$PID" =~ ^[1-9][0-9]*$ ]] && ! kill -0 "$PID" 2>/dev/null; then
      remove_file "$LOCK/pid"
      rmdir "$LOCK" 2>/dev/null || :
    fi
    rmdir "$LOCK.reap" 2>/dev/null || :
  fi
  if [ ! -d "$LOCK" ]; then
    if mkdir "$LOCK" 2>/dev/null; then break; fi
    [ -d "$LOCK" ] || fail 76 "cannot create install lock at $LOCK"
  fi
  [ "$POLL" -lt 300 ] || fail 75 'lock wait exceeded 300 seconds'
  sleep 1 || fail 75 'cannot wait for the install lock'
  POLL=$((POLL + 1))
done
LOCK_HELD=1
printf '%s\n' "$$" > "$LOCK/pid" || fail 76 'cannot write install lock pid'
if [ -f "$BIN" ] && [ -x "$BIN" ]; then
  point_current
  remove_file "$DATA/install-error" || fail 76 'cannot clear install-error'
  exit 0
fi

command -v curl >/dev/null 2>&1 || fail 73 'curl is not installed — install curl to download iter8'
TEMP="$(mktemp -d "$RELEASE_DIR/.download.XXXXXX")" || fail 76 'cannot create download directory'
printf 'iter8: downloading %s from v%s\n' "$ASSET" "$VERSION" >&2
BASE_URL="https://github.com/$REPO/releases/download/v$VERSION"
for NAME in "$ASSET" SHA256SUMS; do
  curl --fail --silent --show-error --location --proto '=https' --retry 2 --output "$TEMP/$NAME" "$BASE_URL/$NAME" >&2 || fail 76 "release download failed: $BASE_URL/$NAME"
done
[ -f "$TEMP/$ASSET" ] && [ -f "$TEMP/SHA256SUMS" ] || fail 76 'release download did not provide the binary and SHA256SUMS'

EXPECTED=""
SUM_PATTERN='^([0-9a-fA-F]{64})  (iter8-linux-x64|iter8-darwin-arm64)$'
while IFS= read -r LINE || [ -n "$LINE" ]; do
  if [[ "$LINE" =~ $SUM_PATTERN ]] && [ "${BASH_REMATCH[2]}" = "$ASSET" ]; then
    [ -z "$EXPECTED" ] || fail 72 "duplicate SHA256SUMS entry for $ASSET"
    EXPECTED="${BASH_REMATCH[1]}"
  fi
done < "$TEMP/SHA256SUMS"
[ -n "$EXPECTED" ] || fail 72 "SHA256SUMS has no valid entry for $ASSET"
EXPECTED="$(printf '%s' "$EXPECTED" | tr 'A-F' 'a-f')"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TEMP/$ASSET")" || fail 72 'cannot hash downloaded binary'
else
  ACTUAL="$(shasum -a 256 "$TEMP/$ASSET")" || fail 72 'cannot hash downloaded binary'
fi
ACTUAL="${ACTUAL%% *}"
[ "$ACTUAL" = "$EXPECTED" ] || fail 72 "checksum mismatch with SHA256SUMS for $ASSET"
[ "$EXPECTED" = "$PIN" ] || fail 72 "checksum mismatch with release.json pin for $ASSET"
chmod 755 "$TEMP/$ASSET" || fail 76 'cannot make downloaded binary executable'
# The sentinel preserves trailing newlines so extra output fails the smoke check.
SMOKE="$("$TEMP/$ASSET" --version 2>/dev/null; RC=$?; printf '\001'; exit "$RC")" || fail 77 'downloaded binary failed its --version smoke check'
if [ "$SMOKE" != "iter8 $VERSION"$'\n\001' ] && [ "$SMOKE" != "iter8 $VERSION"$'\001' ]; then
  fail 77 "downloaded binary must print exactly iter8 $VERSION for --version"
fi
mv -f "$TEMP/$ASSET" "$BIN" || fail 76 "cannot install binary at $BIN"
point_current
remove_file "$DATA/install-error" || fail 76 'cannot clear install-error'
printf 'iter8: installed v%s\n' "$VERSION" >&2

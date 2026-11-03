#!/usr/bin/env bash
set -uo pipefail

SELF="${BASH_SOURCE[0]}"
SELF_DIR="${SELF%/*}"
[ "$SELF_DIR" = "$SELF" ] && SELF_DIR="."
ROOT="$(cd -- "$SELF_DIR/.." && pwd)"
fail() { printf 'iter8: %s\n' "$2" >&2; exit "$1"; }
[ "$#" -eq 1 ] || fail 64 'usage: scripts/pin-release.sh <version>'
VERSION="${1#v}"
VERSION_FORMAT='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
[[ "$VERSION" =~ $VERSION_FORMAT ]] || fail 64 'version must be 1.2.3 or v1.2.3'
command -v gh >/dev/null 2>&1 || fail 73 'gh is not installed — install GitHub CLI'
command -v jq >/dev/null 2>&1 || fail 78 'jq is required to update release.json'
REPO="$(jq -er '.repo | select(type == "string" and length > 0)' "$ROOT/release.json")" || fail 78 'release.json has no repo'
TEMP="$(mktemp -d "${TMPDIR:-/tmp}/iter8-pin.XXXXXX")" || fail 76 'cannot create pin directory'
cleanup() {
  [ ! -e "$TEMP/SHA256SUMS" ] || unlink "$TEMP/SHA256SUMS"
  [ ! -e "$TEMP/release.json" ] || unlink "$TEMP/release.json"
  rmdir "$TEMP" 2>/dev/null || :
}
trap cleanup EXIT
trap 'fail 76 "pinning interrupted"' HUP INT TERM
gh release download "v$VERSION" --repo "$REPO" --pattern SHA256SUMS --dir "$TEMP" >&2 || fail 76 'SHA256SUMS download failed'
[ -f "$TEMP/SHA256SUMS" ] || fail 76 'release has no SHA256SUMS'
LINUX=""
DARWIN=""
SUM_PATTERN='^([0-9a-fA-F]{64})  (iter8-linux-x64|iter8-darwin-arm64)$'
while IFS= read -r LINE || [ -n "$LINE" ]; do
  if [[ "$LINE" =~ $SUM_PATTERN ]]; then
    HASH="${BASH_REMATCH[1]}"
    case "${BASH_REMATCH[2]}" in
      iter8-linux-x64) [ -z "$LINUX" ] || fail 72 'duplicate iter8-linux-x64 checksum'; LINUX="$HASH" ;;
      iter8-darwin-arm64) [ -z "$DARWIN" ] || fail 72 'duplicate iter8-darwin-arm64 checksum'; DARWIN="$HASH" ;;
    esac
  fi
done < "$TEMP/SHA256SUMS"
[ -n "$LINUX" ] && [ -n "$DARWIN" ] || fail 72 'SHA256SUMS must contain iter8-linux-x64 and iter8-darwin-arm64'
jq --indent 2 --arg version "$VERSION" --arg linux "$LINUX" --arg darwin "$DARWIN" '.version = $version | .sha256 = {"iter8-linux-x64": ($linux | ascii_downcase), "iter8-darwin-arm64": ($darwin | ascii_downcase)}' "$ROOT/release.json" > "$TEMP/release.json" || fail 78 'cannot update release.json'
mv -f "$TEMP/release.json" "$ROOT/release.json" || fail 76 'cannot write release.json'
printf 'iter8: pinned v%s\n' "$VERSION" >&2

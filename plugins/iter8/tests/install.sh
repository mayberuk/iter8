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
assert_absent() {
  if [ ! -e "$1" ]; then pass "$2"; else fail "$2 ($1 exists)"; fi
}

SELF="${BASH_SOURCE[0]}"
DIR="${SELF%/*}"
[ "$DIR" = "$SELF" ] && DIR="."
ROOT="$(cd -- "$DIR/.." && pwd)"
MARKETPLACE="$ROOT/../../.claude-plugin/marketplace.json"
for TOOL in jq bash; do
  command -v "$TOOL" >/dev/null 2>&1 || { fail "$TOOL is required to run these tests"; exit "$FAIL"; }
done
TMP="$(mktemp -d)" || exit 1
PIDS=""
cleanup() {
  for PID in $PIDS; do kill "$PID" 2>/dev/null || :; wait "$PID" 2>/dev/null || :; done
  find "$TMP" -depth -delete
}
trap cleanup EXIT
export HOME="$TMP/home" XDG_DATA_HOME="$TMP/xdg-data" TMPDIR="$TMP"
mkdir -p "$HOME" "$XDG_DATA_HOME" "$TMP/tools" "$TMP/hot-path"
TOOLS="$TMP/tools"
for TOOL in bash jq mkdir rmdir unlink mktemp sleep chmod mv cp ln readlink tr sha256sum shasum; do
  LOCATION="$(command -v "$TOOL" 2>/dev/null)"
  [ -z "$LOCATION" ] || ln -s "$LOCATION" "$TOOLS/$TOOL"
done
ln -s "$(command -v bash)" "$TMP/hot-path/bash"
printf '%s\n' '#!/usr/bin/env bash' 'case "$1" in' '  -s) printf "%s\n" "$FAKE_UNAME_S" ;;' '  -m) printf "%s\n" "$FAKE_UNAME_M" ;;' '  *) exit 1 ;;' 'esac' > "$TOOLS/uname"
chmod 755 "$TOOLS/uname"
CASE_COUNT=0
export FAKE_UNAME_S=Linux FAKE_UNAME_M=x86_64
unset ITER8_BIN ITER8_NO_INSTALL ITER8_PINNED_VERSION FAKE_DELAY FAKE_DOWNLOAD

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then HASH="$(sha256sum "$1")"; else HASH="$(shasum -a 256 "$1")"; fi
  printf '%s' "${HASH%% *}"
}
refresh_pin() {
  LINUX_HASH="$(hash_file "$FAKE_ASSETS/iter8-linux-x64")"
  DARWIN_HASH="$(hash_file "$FAKE_ASSETS/iter8-darwin-arm64")"
  printf '%s  iter8-linux-x64\n%s  iter8-darwin-arm64\n' "$LINUX_HASH" "$DARWIN_HASH" > "$FAKE_ASSETS/SHA256SUMS"
  jq --arg linux "$LINUX_HASH" --arg darwin "$DARWIN_HASH" '.version = "9.9.9" | .sha256 = {"iter8-linux-x64": $linux, "iter8-darwin-arm64": $darwin}' "$ROOT/release.json" > "$PLUGIN/release.json"
}
new_case() {
  CASE_COUNT=$((CASE_COUNT + 1))
  CASE="$TMP/case $CASE_COUNT"
  PLUGIN="$CASE/plugin"
  mkdir -p "$PLUGIN" "$CASE/assets" "$CASE/fake-bin" "$CASE/gh-bin"
  cp -R "$ROOT/bin" "$ROOT/scripts" "$ROOT/.claude-plugin" "$PLUGIN/"
  cp "$ROOT/tests/fixtures/fake-curl" "$CASE/fake-bin/curl"
  cp "$ROOT/tests/fixtures/fake-gh" "$CASE/gh-bin/gh"
  export FAKE_ASSETS="$CASE/assets" FAKE_CURL_LOG="$CASE/curl.log" FAKE_GH_LOG="$CASE/gh.log" ITER8_PLUGIN_DATA="$CASE/data"
  export FAKE_CURL_REPO=mayberuk/iter8 FAKE_CURL_VERSION=9.9.9
  : > "$FAKE_CURL_LOG"
  : > "$FAKE_GH_LOG"
  printf '%s\n' '#!/usr/bin/env bash' 'if [ "${1:-}" = --version ]; then' '  printf "iter8 9.9.9\n"' 'else' '  printf "<%s>\n" "$@"' 'fi' > "$FAKE_ASSETS/iter8-linux-x64"
  cp "$FAKE_ASSETS/iter8-linux-x64" "$FAKE_ASSETS/iter8-darwin-arm64"
  chmod 755 "$FAKE_ASSETS/iter8-linux-x64" "$FAKE_ASSETS/iter8-darwin-arm64"
  refresh_pin
  INSTALL="$PLUGIN/scripts/install.sh"
  LAUNCH="$PLUGIN/bin/iter8"
  PIN_SCRIPT="$PLUGIN/scripts/pin-release.sh"
  INSTALLED="$ITER8_PLUGIN_DATA/releases/v9.9.9/iter8"
  CASE_PATH="$CASE/fake-bin:$TOOLS"
  PIN_PATH="$CASE/gh-bin:$TOOLS"
  export FAKE_UNAME_S=Linux FAKE_UNAME_M=x86_64
  unset ITER8_BIN ITER8_NO_INSTALL ITER8_PINNED_VERSION FAKE_DELAY FAKE_DOWNLOAD
}
fake_release() {
  mkdir -p "$ITER8_PLUGIN_DATA/releases/v$1"
  printf '%s\n' '#!/usr/bin/env bash' "printf 'release $1 pinned %s\\n' \"\${ITER8_PINNED_VERSION-unset}\"" > "$ITER8_PLUGIN_DATA/releases/v$1/iter8"
  chmod "${2:-755}" "$ITER8_PLUGIN_DATA/releases/v$1/iter8"
}
launched() {
  run env PATH="$TMP/hot-path" "$LAUNCH"
  assert_eq "$OUT" "$1" "$2"
}
run() {
  OUT="$("$@" 2> "$CASE/stderr")"
  RC=$?
  ERR="$(<"$CASE/stderr")"
}
install_failure() {
  run env PATH="$CASE_PATH" "$INSTALL"
  assert_eq "$RC" "$1" "$2 status"
  assert_absent "$INSTALLED" "$2 leaves no installed binary"
  assert_contains "$(<"$ITER8_PLUGIN_DATA/install-error")" "$3" "$2 records its reason"
}

printf '%s\n' 'iter8 install and launcher tests'
new_case
run env PATH="$CASE_PATH" ITER8_BIN="$FAKE_ASSETS/iter8-linux-x64" "$LAUNCH" 'two words' '' '*' '--flag=x'
assert_eq "$RC" 0 'override executes successfully'
assert_eq "$OUT" $'<two words>\n<>\n<*>\n<--flag=x>' 'override preserves argument boundaries and empty arguments'
assert_eq "$(<"$FAKE_CURL_LOG")" '' 'override does not call curl'
run env PATH="$CASE_PATH" ITER8_BIN="$CASE/missing" "$LAUNCH"
assert_eq "$RC" 127 'non-executable override exits 127'
assert_contains "$ERR" "ITER8_BIN=$CASE/missing is not executable" 'override failure names its path'
run env PATH="$CASE_PATH" ITER8_BIN= "$LAUNCH"
assert_eq "$RC" 127 'an explicitly empty override is refused'
run env PATH="$CASE_PATH" ITER8_BIN="$CASE" "$LAUNCH"
assert_eq "$RC" 127 'a directory override is refused'

new_case
mkdir -p "${INSTALLED%/*}"
cp "$FAKE_ASSETS/iter8-linux-x64" "$INSTALLED"
run env PATH="$TMP/hot-path" "$LAUNCH" 'two words' '' '*' '--flag=x'
assert_eq "$RC" 0 'installed launcher runs with only bash on PATH'
assert_eq "$OUT" $'<two words>\n<>\n<*>\n<--flag=x>' 'installed launcher preserves arguments'
assert_eq "$(<"$FAKE_CURL_LOG")" '' 'installed launcher does not call curl'
run env PATH="$TMP/hot-path" "$LAUNCH" --version
assert_eq "$OUT" 'iter8 9.9.9' 'installed launcher selects the pinned version'

new_case
fake_release 9.9.9
fake_release 9.9.8
fake_release 9.10.0
launched 'release 9.10.0 pinned 9.9.9' 'launcher runs the newest release, comparing numbers rather than text'
run env PATH="$TMP/hot-path" ITER8_PINNED_VERSION=1.0.0 "$LAUNCH"
assert_eq "$OUT" 'release 9.10.0 pinned 9.9.9' 'launcher exports the pinned version over an inherited one'
assert_eq "$(<"$FAKE_CURL_LOG")" '' 'a newer release does not call curl'

new_case
fake_release 9.9.9
fake_release 9.9.8
launched 'release 9.9.9 pinned 9.9.9' 'an older release does not outrank the pin'

new_case
fake_release 9.9.8
run env PATH="$CASE_PATH" "$LAUNCH" 'older only'
assert_eq "$OUT" '<older only>' 'with only an older release the launcher installs and runs the pin'
assert_eq "$(<"$FAKE_ASSETS/iter8-linux-x64.count")" 1 'an older release does not satisfy the pin'
new_case
fake_release 9.9.8
run env PATH="$CASE_PATH" ITER8_NO_INSTALL=1 "$LAUNCH"
assert_eq "$RC" 69 'no-install with only an older release exits 69'

new_case
fake_release 9.10.0
run env PATH="$TMP/hot-path" "$LAUNCH"
assert_eq "$OUT" 'release 9.10.0 pinned 9.9.9' 'a newer release runs although the pinned one is missing'
assert_absent "$INSTALLED" 'a newer release spares the pinned download'

new_case
fake_release 9.9.9
fake_release 9.9.9-rc.1
launched 'release 9.9.9 pinned 9.9.9' 'a prerelease sorts below its release'
new_case
fake_release 9.9.9-rc.1
run env PATH="$CASE_PATH" "$LAUNCH" 'prerelease only'
assert_eq "$OUT" '<prerelease only>' 'a prerelease of the pin does not satisfy the pin'
new_case
fake_release 9.9.9
fake_release 10.0.0-rc.2
fake_release 10.0.0-rc.10
fake_release 10.0.0-beta.99
launched 'release 10.0.0-rc.10 pinned 9.9.9' 'a prerelease of a higher version outranks the pin, numeric identifiers by value'
fake_release 10.0.0
launched 'release 10.0.0 pinned 9.9.9' 'the release outranks its prereleases'

new_case
fake_release 9.9.9
fake_release 99.0.0.1
fake_release latest
fake_release 99.0
fake_release 99.0.0-
fake_release 99.0.1 644
launched 'release 9.9.9 pinned 9.9.9' 'malformed and non-executable release directories are ignored'

new_case
run env PATH="$CASE_PATH" ITER8_NO_INSTALL=1 "$LAUNCH"
assert_eq "$RC" 69 'no-install missing binary exits 69'
assert_eq "$(<"$FAKE_CURL_LOG")" '' 'no-install does not call curl'
assert_absent "$INSTALLED" 'no-install leaves no binary'
jq '.version = null | .sha256 = {"iter8-linux-x64": null, "iter8-darwin-arm64": null}' "$ROOT/release.json" > "$PLUGIN/release.json"
run env PATH="$CASE_PATH" "$LAUNCH"
assert_eq "$RC" 78 'null version exits 78'
assert_contains "$ERR" scripts/pin-release.sh 'null version names the pin command'
assert_eq "$(<"$FAKE_CURL_LOG")" '' 'null version does not call curl'
install_failure 78 'unconfigured installer' scripts/pin-release.sh
jq 'del(.version)' "$ROOT/release.json" > "$PLUGIN/release.json"
run env PATH="$CASE_PATH" "$LAUNCH"
assert_eq "$RC" 78 'missing version exits 78'

new_case
mkdir -p "$ITER8_PLUGIN_DATA"
printf 'old failure\n' > "$ITER8_PLUGIN_DATA/install-error"
run env PATH="$CASE_PATH" "$LAUNCH" 'first use' '' '*'
assert_eq "$RC" 0 'launcher installs on first use'
assert_eq "$OUT" $'<first use>\n<>\n<*>' 'launcher forwards arguments after installing'
assert_eq "$(<"$FAKE_ASSETS/iter8-linux-x64.count")" 1 'first use downloads one binary'
LOG="$(<"$FAKE_CURL_LOG")"
BASE=https://github.com/mayberuk/iter8/releases/download/v9.9.9
assert_contains "$LOG" "$BASE/iter8-linux-x64" 'Linux download uses the pinned tag, repo and asset over https'
assert_contains "$LOG" "$BASE/SHA256SUMS" 'the checksum list comes from the same tag'
assert_contains "$LOG" '--proto =https' 'curl refuses a redirect away from https'
printf -v DOWNLOAD_PREFIX '%q' "$ITER8_PLUGIN_DATA/releases/v9.9.9/.download."
assert_contains "$LOG" "$DOWNLOAD_PREFIX" 'download directory is under the version data directory'
assert_absent "$ITER8_PLUGIN_DATA/install-error" 'successful install clears an old failure'
assert_absent "${INSTALLED%/*}/.lock" 'successful install releases the lock'
printf 'another old failure\n' > "$ITER8_PLUGIN_DATA/install-error"
BEFORE="$LOG"
run env PATH="$TOOLS" "$INSTALL"
assert_eq "$RC" 0 'already installed succeeds without curl on PATH'
assert_eq "$(<"$FAKE_CURL_LOG")" "$BEFORE" 'already installed does not call curl'
assert_absent "$ITER8_PLUGIN_DATA/install-error" 'already installed clears an old failure'

new_case
mkdir -p "$XDG_DATA_HOME/iter8-claude-plugin/releases/v9.9.9"
cp "$FAKE_ASSETS/iter8-linux-x64" "$XDG_DATA_HOME/iter8-claude-plugin/releases/v9.9.9/iter8"
run env -u ITER8_PLUGIN_DATA PATH="$TMP/hot-path" "$LAUNCH" 'xdg default'
assert_eq "$RC" 0 'launcher uses XDG_DATA_HOME by default'
assert_eq "$OUT" '<xdg default>' 'XDG default selects the installed binary'
mkdir -p "$HOME/.local/share/iter8-claude-plugin/releases/v9.9.9"
cp "$FAKE_ASSETS/iter8-linux-x64" "$HOME/.local/share/iter8-claude-plugin/releases/v9.9.9/iter8"
run env -u ITER8_PLUGIN_DATA -u XDG_DATA_HOME PATH="$TMP/hot-path" "$LAUNCH" 'home default'
assert_eq "$RC" 0 'launcher falls back to HOME data directory'
assert_eq "$OUT" '<home default>' 'HOME default selects the installed binary'

new_case
mkdir -p "$CASE/fallback-tools"
for TOOL_PATH in "$TOOLS"/*; do
  [ "${TOOL_PATH##*/}" = sha256sum ] || ln -s "$TOOL_PATH" "$CASE/fallback-tools/${TOOL_PATH##*/}"
done
if [ ! -x "$TOOLS/shasum" ]; then
  export FAKE_SHA256SUM="$(command -v sha256sum)"
  printf '%s\n' '#!/usr/bin/env bash' '[ "$#" -eq 3 ] && [ "$1" = -a ] && [ "$2" = 256 ] || exit 1' 'exec "$FAKE_SHA256SUM" "$3"' > "$CASE/fake-bin/shasum"
  chmod 755 "$CASE/fake-bin/shasum"
fi
run env PATH="$CASE/fake-bin:$CASE/fallback-tools" "$INSTALL"
assert_eq "$RC" 0 'installer hashes with shasum -a 256 when sha256sum is absent'

new_case
export FAKE_UNAME_S=Darwin FAKE_UNAME_M=arm64
run env PATH="$CASE_PATH" "$INSTALL"
assert_eq "$RC" 0 'Darwin arm64 install succeeds'
assert_contains "$(<"$FAKE_CURL_LOG")" 'releases/download/v9.9.9/iter8-darwin-arm64' 'Darwin downloads its binary'
assert_eq "$(<"$FAKE_ASSETS/iter8-darwin-arm64.count")" 1 'Darwin downloads one binary'

new_case
printf '\n' >> "$FAKE_ASSETS/iter8-linux-x64"
install_failure 72 'asset checksum mismatch' SHA256SUMS
assert_absent "${INSTALLED%/*}/.lock" 'checksum failure releases the lock'

new_case
jq '.sha256["iter8-linux-x64"] = ("0" * 64)' "$PLUGIN/release.json" > "$CASE/pin.json"
mv "$CASE/pin.json" "$PLUGIN/release.json"
install_failure 72 'pinned checksum mismatch' release.json

new_case
printf '%s\n' '#!/usr/bin/env bash' 'printf "iter8 wrong\n"' > "$FAKE_ASSETS/iter8-linux-x64"
refresh_pin
install_failure 77 'wrong version output' 'exactly iter8 9.9.9'

new_case
printf '%s\n' '#!/usr/bin/env bash' 'printf "iter8 9.9.9\n\n"' > "$FAKE_ASSETS/iter8-linux-x64"
refresh_pin
install_failure 77 'extra version output' 'exactly iter8 9.9.9'

new_case
printf '%s\n' '#!/usr/bin/env bash' 'printf "iter8 9.9.9\n"' 'exit 1' > "$FAKE_ASSETS/iter8-linux-x64"
refresh_pin
install_failure 77 'nonzero version check' 'smoke check'

new_case
export FAKE_UNAME_S=Linux FAKE_UNAME_M=arm64
install_failure 71 'unsupported platform' Linux/arm64
assert_contains "$ERR" linux-x64 'unsupported message names Linux support'
assert_contains "$ERR" darwin-arm64 'unsupported message names Darwin support'
assert_eq "$(<"$FAKE_CURL_LOG")" '' 'unsupported platform does not call curl'

new_case
export FAKE_DOWNLOAD=fail
install_failure 76 'download refused' 'release download failed'
assert_contains "$ERR" 'releases/download/v9.9.9/iter8-linux-x64' 'download failure names the URL'
run env PATH="$CASE_PATH" "$LAUNCH"
assert_eq "$RC" 76 'launcher propagates install failure status'

new_case
run env PATH="$TOOLS" "$INSTALL"
assert_eq "$RC" 73 'missing curl exits 73'
assert_absent "$INSTALLED" 'missing curl leaves no binary'
assert_contains "$(<"$ITER8_PLUGIN_DATA/install-error")" 'curl is not installed' 'missing curl records its reason'

new_case
assert_eq "$(PATH="$CASE_PATH" command -v gh || echo none)" none 'the install PATH has no gh'
printf '%s\n' '#!/usr/bin/env bash' 'echo "gh must not run" >&2' 'exit 1' > "$CASE/fake-bin/gh"
chmod 755 "$CASE/fake-bin/gh"
run env PATH="$CASE_PATH" "$INSTALL"
assert_eq "$RC" 0 'install succeeds with no usable gh'
assert_eq "$ERR" $'iter8: downloading iter8-linux-x64 from v9.9.9\niter8: installed v9.9.9' 'install without gh prints only its own progress'
assert_eq "$(<"$FAKE_ASSETS/iter8-linux-x64.count")" 1 'install without gh downloads over curl once'

new_case
jq 'del(.repo)' "$PLUGIN/release.json" > "$CASE/pin.json"
mv "$CASE/pin.json" "$PLUGIN/release.json"
install_failure 78 'missing repo' 'no valid repo'

new_case
printf '%s  iter8-linux-x64\n' "$LINUX_HASH" >> "$FAKE_ASSETS/SHA256SUMS"
install_failure 72 'duplicate checksum entry' 'duplicate SHA256SUMS'

new_case
mkdir -p "${INSTALLED%/*}"
printf 'not a directory\n' > "${INSTALLED%/*}/.lock"
install_failure 76 'invalid lock path' 'cannot create install lock'

new_case
mkdir -p "$INSTALLED"
run env PATH="$CASE_PATH" "$LAUNCH"
assert_eq "$RC" 76 'a directory at the binary path is refused'
assert_contains "$(<"$ITER8_PLUGIN_DATA/install-error")" 'install path is a directory' 'invalid binary path records its reason'
assert_eq "$(<"$FAKE_CURL_LOG")" '' 'invalid binary path does not download'

new_case
export FAKE_DELAY=1
env PATH="$CASE_PATH" "$INSTALL" > "$CASE/first.out" 2> "$CASE/first.err" &
FIRST=$!
PIDS="$FIRST"
env PATH="$CASE_PATH" "$INSTALL" > "$CASE/second.out" 2> "$CASE/second.err" &
SECOND=$!
PIDS="$PIDS $SECOND"
wait "$FIRST"; FIRST_RC=$?
wait "$SECOND"; SECOND_RC=$?
PIDS=""
assert_eq "$FIRST_RC" 0 'first concurrent install succeeds'
assert_eq "$SECOND_RC" 0 'second concurrent install succeeds'
assert_eq "$(<"$FAKE_ASSETS/iter8-linux-x64.count")" 1 'concurrent installs download the binary once'
assert_absent "${INSTALLED%/*}/.lock" 'concurrent installs leave no lock'

new_case
mkdir -p "${INSTALLED%/*}/.lock"
DEAD_PID="$(bash -c 'printf "%s" "$$"')"
printf '%s\n' "$DEAD_PID" > "${INSTALLED%/*}/.lock/pid"
run env PATH="$CASE_PATH" "$INSTALL"
assert_eq "$RC" 0 'dead pid lock is reclaimed'
assert_eq "$(<"$FAKE_ASSETS/iter8-linux-x64.count")" 1 'stale lock recovery downloads once'

new_case
mkdir -p "${INSTALLED%/*}/.lock"
printf '%s\n' "$$" > "${INSTALLED%/*}/.lock/pid"
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "$*" >> "$FAKE_SLEEP_LOG"' > "$CASE/fake-bin/sleep"
chmod 755 "$CASE/fake-bin/sleep"
export FAKE_SLEEP_LOG="$CASE/sleep.log"
install_failure 75 'live lock timeout' '300 seconds'
assert_eq "$(wc -l < "$FAKE_SLEEP_LOG" | tr -d ' ')" 300 'lock polls once per second for 300 seconds'
assert_eq "$(<"$FAKE_CURL_LOG")" '' 'lock timeout does not call curl'
assert_eq "$(<"${INSTALLED%/*}/.lock/pid")" "$$" 'lock timeout preserves the live owner lock'

new_case
run env PATH="$CASE_PATH" "$INSTALL"
assert_eq "$(readlink "$ITER8_PLUGIN_DATA/current")" "$INSTALLED" 'install points current at the installed release'

new_case
fake_release 10.0.0
run env PATH="$CASE_PATH" "$INSTALL"
assert_eq "$(readlink "$ITER8_PLUGIN_DATA/current")" "$ITER8_PLUGIN_DATA/releases/v10.0.0/iter8" 'install points current at the newest installed release'

new_case
fake_release 10.0.0
mkdir -p "$ITER8_PLUGIN_DATA"
ln -s "$ITER8_PLUGIN_DATA/releases/v10.0.0/iter8" "$ITER8_PLUGIN_DATA/current"
run env PATH="$CASE_PATH" "$INSTALL"
assert_eq "$RC" 0 'install beside a newer current succeeds'
assert_eq "$(readlink "$ITER8_PLUGIN_DATA/current")" "$ITER8_PLUGIN_DATA/releases/v10.0.0/iter8" 'install never downgrades current'
assert_eq "$(<"$FAKE_ASSETS/iter8-linux-x64.count")" 1 'the pin is still installed beside a newer current'

new_case
fake_release 9.0.0
ln -s "$ITER8_PLUGIN_DATA/releases/v9.0.0/iter8" "$ITER8_PLUGIN_DATA/current"
run env PATH="$CASE_PATH" "$INSTALL"
assert_eq "$(readlink "$ITER8_PLUGIN_DATA/current")" "$INSTALLED" 'install moves an older current forward'
STAGING=("$ITER8_PLUGIN_DATA"/current.*)
assert_absent "${STAGING[0]}" 'no staging link is left after the swap'

new_case
fake_release 9.0.0
ln -s "$ITER8_PLUGIN_DATA/releases/v99.0.0/iter8" "$ITER8_PLUGIN_DATA/current"
run env PATH="$CASE_PATH" "$INSTALL"
assert_eq "$(readlink "$ITER8_PLUGIN_DATA/current")" "$INSTALLED" 'install repoints a current whose release is gone'

new_case
fake_release 9.9.9
run env PATH="$TOOLS" "$INSTALL"
assert_eq "$(readlink "$ITER8_PLUGIN_DATA/current")" "$INSTALLED" 'an already installed pin still gets current'

new_case
run env PATH="$PIN_PATH" "$PIN_SCRIPT" v1.2.3
assert_eq "$RC" 0 'pin accepts a v-prefixed version'
assert_eq "$(jq -r .version "$PLUGIN/release.json")" 1.2.3 'pin writes the version without v'
assert_eq "$(jq -r .repo "$PLUGIN/release.json")" mayberuk/iter8 'pin preserves the repo'
assert_eq "$(jq -r '.sha256["iter8-linux-x64"]' "$PLUGIN/release.json")" "$LINUX_HASH" 'pin writes the Linux checksum from SHA256SUMS'
assert_eq "$(jq -r '.sha256["iter8-darwin-arm64"]' "$PLUGIN/release.json")" "$DARWIN_HASH" 'pin writes the Darwin checksum from SHA256SUMS'
assert_contains "$(<"$FAKE_GH_LOG")" 'release download v1.2.3 --repo mayberuk/iter8 --pattern SHA256SUMS --dir' 'pin downloads only SHA256SUMS from the requested tag'
assert_absent "$FAKE_ASSETS/iter8-linux-x64.count" 'pin does not download a binary'
assert_contains "$(<"$PLUGIN/release.json")" $'\n  "version": "1.2.3"' 'pin preserves two-space formatting'
run env PATH="$PIN_PATH" "$PIN_SCRIPT" 2.3.4
assert_eq "$RC" 0 'pin accepts a plain version'
assert_eq "$(jq -r .version "$PLUGIN/release.json")" 2.3.4 'plain version is written'
BEFORE="$(<"$PLUGIN/release.json")"
printf '%s  iter8-linux-x64\n' "$LINUX_HASH" > "$FAKE_ASSETS/SHA256SUMS"
run env PATH="$PIN_PATH" "$PIN_SCRIPT" 3.4.5
assert_eq "$RC" 72 'pin refuses a missing asset checksum'
assert_eq "$(<"$PLUGIN/release.json")" "$BEFORE" 'invalid checksum list leaves the pin unchanged'
run env PATH="$PIN_PATH" "$PIN_SCRIPT" ../bad
assert_eq "$RC" 64 'pin refuses invalid versions'
run env PATH="$PIN_PATH" "$PIN_SCRIPT"
assert_eq "$RC" 64 'pin requires a version argument'

ENTRY="$(jq -c '.plugins[] | select(.name == "iter8")' "$MARKETPLACE")"
assert_eq "$(jq -r '.plugins | map(select(.name == "iter8")) | length' "$MARKETPLACE")" 1 'marketplace registers iter8 once'
assert_eq "$(printf '%s' "$ENTRY" | jq -r .source)" ./plugins/iter8 'marketplace points to the plugin'
assert_eq "$(printf '%s' "$ENTRY" | jq -r .version)" "$(jq -r .version "$ROOT/.claude-plugin/plugin.json")" 'marketplace and manifest versions agree'
assert_eq "$(printf '%s' "$ENTRY" | jq -r .description)" "$(jq -r .description "$ROOT/.claude-plugin/plugin.json")" 'marketplace and manifest descriptions agree'
assert_eq "$(printf '%s' "$ENTRY" | jq -c .keywords)" "$(jq -c .keywords "$ROOT/.claude-plugin/plugin.json")" 'marketplace and manifest keywords agree'

echo ""
echo "install: $PASS passed, $FAIL failed"
exit "$FAIL"

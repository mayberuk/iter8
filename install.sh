#!/bin/sh
# Installs the iter8 command on a machine that has no Claude Code plugin, such as the laptop half
# of a remote-dev setup:  curl -fsSL https://raw.githubusercontent.com/mayberuk/iter8/main/install.sh | sh
#
#   ITER8_VERSION   release to install, for example 0.4.6 (default: the latest release)
#   ITER8_BIN_DIR   where to put the iter8 binary (default: $HOME/.local/bin)
set -eu

# ITER8_RELEASE_BASE exists so the tests can serve a release from a local http server; any
# non-https value drops the https-only guard, so leave it unset.
BASE="${ITER8_RELEASE_BASE:-https://github.com/mayberuk/iter8}"

say() { printf 'iter8-install: %s\n' "$1"; }
die() { printf 'iter8-install: %s\n' "$1" >&2; exit 1; }

TMP=""
cleanup() {
  if [ -n "$TMP" ]; then
    rm -f "$TMP/asset" "$TMP/SHA256SUMS"
    rmdir "$TMP" 2>/dev/null || :
  fi
}

http() {
  curl --fail --silent --show-error --proto "$PROTO" --proto-redir "$PROTO" --retry 2 "$@"
}

hash_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    die 'need sha256sum or shasum to verify the download'
  fi
}

main() {
  command -v curl >/dev/null 2>&1 || die 'curl is required'

  case "$BASE" in
    https://*) PROTO='=https' ;;
    *) PROTO='=https,http' ;;
  esac

  system="$(uname -s)" || die 'cannot detect the operating system'
  machine="$(uname -m)" || die 'cannot detect the CPU architecture'
  case "$system/$machine" in
    Linux/x86_64 | Linux/amd64) platform=linux-x64 ;;
    Darwin/arm64 | Darwin/aarch64) platform=darwin-arm64 ;;
    *) die "unsupported platform $system/$machine; iter8 runs on linux-x64 and darwin-arm64" ;;
  esac
  asset="iter8-$platform"

  version="${ITER8_VERSION:-}"
  if [ -z "$version" ]; then
    say 'looking up the latest release'
    target="$(http --output /dev/null --write-out '%{redirect_url}' "$BASE/releases/latest")" ||
      die "cannot reach $BASE/releases/latest"
    case "$target" in
      */releases/tag/v*) version="${target##*/releases/tag/v}" ;;
      *) die 'no release has been published yet; set ITER8_VERSION to install a specific one' ;;
    esac
  fi
  version="${version#v}"
  printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$' ||
    die "'$version' is not a version like 1.2.3"

  bin_dir="${ITER8_BIN_DIR:-$HOME/.local/bin}"
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/iter8-install.XXXXXX")" || die 'cannot create a temporary directory'
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM

  url="$BASE/releases/download/v$version"
  say "downloading $asset v$version"
  http --location --output "$TMP/asset" "$url/$asset" || die "download failed: $url/$asset"
  http --location --output "$TMP/SHA256SUMS" "$url/SHA256SUMS" || die "download failed: $url/SHA256SUMS"

  expected="$(awk -v name="$asset" '$2 == name { print $1 }' "$TMP/SHA256SUMS")"
  [ -n "$expected" ] || die "SHA256SUMS has no entry for $asset"
  [ "$(printf '%s\n' "$expected" | wc -l | tr -d ' ')" = 1 ] || die "SHA256SUMS lists $asset more than once"
  printf '%s' "$expected" | grep -Eq '^[0-9A-Fa-f]{64}$' || die "SHA256SUMS has a malformed checksum for $asset"
  expected="$(printf '%s' "$expected" | tr 'A-F' 'a-f')"
  actual="$(hash_of "$TMP/asset")"
  [ "$actual" = "$expected" ] || die "checksum mismatch for $asset; nothing was installed"

  chmod 755 "$TMP/asset" || die 'cannot make the download executable'
  reported="$("$TMP/asset" --version 2>/dev/null)" || die 'the downloaded binary failed to run'
  [ "$reported" = "iter8 $version" ] || die "the downloaded binary reports '$reported', expected 'iter8 $version'"

  mkdir -p "$bin_dir" || die "cannot create $bin_dir"
  # Stage beside the target and rename, so a running iter8 is never overwritten in place.
  cp "$TMP/asset" "$bin_dir/.iter8.$$" || die "cannot write to $bin_dir"
  mv -f "$bin_dir/.iter8.$$" "$bin_dir/iter8" || die "cannot install $bin_dir/iter8"
  say "installed iter8 $version at $bin_dir/iter8"

  case ":${PATH:-}:" in
    *":$bin_dir:"*) command_name=iter8 ;;
    *)
      command_name="$bin_dir/iter8"
      say "$bin_dir is not on your PATH; add it in your shell profile, for example:"
      say "  export PATH=\"$bin_dir:\$PATH\""
      ;;
  esac

  say 'next, point this machine at the dev server that runs your projects:'
  say "  $command_name setup <host>"
  say 'where <host> is its SSH host name. On the machine that runs the projects themselves, run'
  say "  $command_name setup"
}

main

#!/bin/sh
# NoMoreIDE installer.
#
#   curl -fsSL https://www.nomoreide.com/install.sh | sh
#
# Downloads the release archive for this machine, checks it against the
# release's SHA256SUMS, and unpacks it into a prefix — `bin/nomoreide` and
# `share/nomoreide`, which is where the daemon looks for its dashboard. There
# is no Node.js in the result and none needed to run this.
#
# Options (also readable from the environment, for `curl … | sh`):
#   --version <x.y.z>   NOMOREIDE_VERSION   a specific release; default latest
#   --prefix <dir>      NOMOREIDE_PREFIX    default ~/.local
#   --setup <agents>    NOMOREIDE_SETUP     auto (default), none, or a
#                                           comma-separated list of
#                                           claude,codex,gemini
#   --uninstall                             remove what this installed
#   --help
#
# `--setup auto` registers the MCP server with every agent it can find, so the
# one command leaves a working setup rather than a binary and a hint. It writes
# the agent's own config (backing up what was there); `--setup none` skips it.
#
# Exit codes: 0 installed, 1 refused or failed, 2 bad usage.

set -eu

REPO="${NOMOREIDE_REPO:-Rorogogogo/nomoreide}"
# Overridable so the installer can be tested against a local release without
# publishing one. `check-install.sh` is the reason this exists.
BASE_URL="${NOMOREIDE_BASE_URL:-https://github.com/$REPO/releases}"
API_URL="${NOMOREIDE_API_URL:-https://api.github.com/repos/$REPO/releases/latest}"

VERSION="${NOMOREIDE_VERSION:-}"
PREFIX="${NOMOREIDE_PREFIX:-$HOME/.local}"
SETUP="${NOMOREIDE_SETUP:-auto}"
ACTION=install

say() { printf '%s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
# Spelled out rather than read back out of "$0": piped through `sh` there is
# no file to read, and a `--help` that printed nothing would be the one case
# where the help is most needed.
usage() {
  cat <<'USAGE'
NoMoreIDE installer.

  curl -fsSL https://www.nomoreide.com/install.sh | sh

Options (also readable from the environment, for `curl ... | sh`):
  --version <x.y.z>   NOMOREIDE_VERSION   a specific release; default latest
  --prefix <dir>      NOMOREIDE_PREFIX    default ~/.local
  --setup <agents>    NOMOREIDE_SETUP     auto (default), none, or a
                                          comma-separated list of
                                          claude,codex,gemini
  --uninstall                             remove what this installed
  --help

Exit codes: 0 installed, 1 refused or failed, 2 bad usage.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || { usage >&2; exit 2; }; VERSION="$2"; shift 2 ;;
    --version=*) VERSION="${1#--version=}"; shift ;;
    --prefix) [ $# -ge 2 ] || { usage >&2; exit 2; }; PREFIX="$2"; shift 2 ;;
    --prefix=*) PREFIX="${1#--prefix=}"; shift ;;
    --setup) [ $# -ge 2 ] || { usage >&2; exit 2; }; SETUP="$2"; shift 2 ;;
    --setup=*) SETUP="${1#--setup=}"; shift ;;
    --no-setup) SETUP=none; shift ;;
    --uninstall) ACTION=uninstall; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'install.sh: unknown option %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

# Validated here rather than where it is used: a misspelled agent is a usage
# error, and finding out after the download has landed and the binary is in
# place is the wrong moment to be told the arguments were wrong.
case "$SETUP" in
  auto|none) ;;
  *)
    for agent in $(printf '%s' "$SETUP" | tr ',' ' '); do
      case "$agent" in
        claude|codex|gemini) ;;
        *)
          printf 'install.sh: --setup: unknown agent %s (expected claude, codex, gemini, auto or none)\n' "$agent" >&2
          exit 2
          ;;
      esac
    done
    ;;
esac

# `~` is not expanded when it arrives in a variable rather than as a word.
case "$PREFIX" in
  "~") PREFIX="$HOME" ;;
  "~/"*) PREFIX="$HOME/${PREFIX#\~/}" ;;
esac

# ---------------------------------------------------------------- uninstall

if [ "$ACTION" = uninstall ]; then
  removed=0
  if [ -e "$PREFIX/bin/nomoreide" ]; then
    rm -f "$PREFIX/bin/nomoreide"
    note "removed $PREFIX/bin/nomoreide"
    removed=1
  fi
  if [ -d "$PREFIX/share/nomoreide" ]; then
    rm -rf "$PREFIX/share/nomoreide"
    note "removed $PREFIX/share/nomoreide"
    removed=1
  fi
  if [ "$removed" -eq 0 ]; then
    say "Nothing installed under $PREFIX."
  else
    say "NoMoreIDE removed from $PREFIX."
    # The agent configs are the user's, and a config naming a binary that is
    # gone is a thing they can see and fix. Deleting them on an uninstall
    # would take away MCP servers this never wrote.
    note "Agent configs were left alone; run \`nomoreide setup\` again after reinstalling."
  fi
  exit 0
fi

# ------------------------------------------------------------ this machine

os=$(uname -s)
arch=$(uname -m)
case "$os/$arch" in
  Darwin/arm64) TARGET=aarch64-apple-darwin ;;
  Darwin/x86_64) TARGET=x86_64-apple-darwin ;;
  Linux/x86_64|Linux/amd64) TARGET=x86_64-unknown-linux-gnu ;;
  Linux/aarch64|Linux/arm64) TARGET=aarch64-unknown-linux-gnu ;;
  *)
    die "no prebuilt release for $os $arch. Build from source: https://github.com/$REPO"
    ;;
esac

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
  read_url() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
  read_url() { wget -qO- "$1"; }
else
  die "neither curl nor wget is installed."
fi

if command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  digest() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "no sha256sum or shasum, so the download cannot be verified."
fi

if [ -z "$VERSION" ]; then
  # The API answers with the release object; the tag is all that is wanted and
  # a dependency on jq is not.
  VERSION=$(read_url "$API_URL" \
    | sed -n 's/.*"tag_name" *: *"v\{0,1\}\([^"]*\)".*/\1/p' \
    | head -1) || true
  [ -n "$VERSION" ] || die "could not work out the latest version from $API_URL"
fi
VERSION="${VERSION#v}"

NAME="nomoreide-$VERSION-$TARGET"
ARCHIVE="$NAME.tar.gz"

# ------------------------------------------------------------ download

WORK=$(mktemp -d "${TMPDIR:-/tmp}/nomoreide-install.XXXXXX")
# Every exit from here on clears the staging directory, including the one where
# the checksum did not match — a rejected download is not left where a later
# run could pick it up.
trap 'rm -rf "$WORK"' EXIT INT TERM

say "Installing NoMoreIDE $VERSION ($TARGET) into $PREFIX"

fetch "$BASE_URL/download/v$VERSION/$ARCHIVE" "$WORK/$ARCHIVE" \
  || die "could not download $ARCHIVE for version $VERSION. Check that the release exists."
fetch "$BASE_URL/download/v$VERSION/SHA256SUMS" "$WORK/SHA256SUMS" \
  || die "could not download SHA256SUMS for version $VERSION."

expected=$(sed -n "s/^\([0-9a-f]\{64\}\)[ *]*$ARCHIVE\$/\1/p" "$WORK/SHA256SUMS" | head -1)
[ -n "$expected" ] || die "SHA256SUMS does not list $ARCHIVE, so this download cannot be verified."
actual=$(digest "$WORK/$ARCHIVE")
if [ "$expected" != "$actual" ]; then
  printf 'install.sh: checksum mismatch for %s\n' "$ARCHIVE" >&2
  printf '  expected %s\n' "$expected" >&2
  printf '  actual   %s\n' "$actual" >&2
  printf '  Nothing was installed. This is worth reporting.\n' >&2
  exit 1
fi
note "checksum ok ($actual)"

tar -xzf "$WORK/$ARCHIVE" -C "$WORK" || die "the archive did not unpack."
[ -x "$WORK/$NAME/bin/nomoreide" ] || die "the archive did not contain bin/nomoreide."

# ------------------------------------------------------------ install

# A prefix that cannot be written to is the most common way this fails, and
# `set -e` would report it as a bare mkdir error from a script the user piped
# in and cannot read.
if ! mkdir -p "$PREFIX/bin" "$PREFIX/share" 2>/dev/null; then
  printf 'install.sh: cannot create %s\n' "$PREFIX" >&2
  printf '  Install somewhere you own — `--prefix "$HOME/.local"` — or re-run with sudo.\n' >&2
  exit 1
fi
if [ ! -w "$PREFIX/bin" ]; then
  printf 'install.sh: %s is not writable.\n' "$PREFIX/bin" >&2
  printf '  Install somewhere you own — `--prefix "$HOME/.local"` — or re-run with sudo.\n' >&2
  exit 1
fi
# Into place beside the old one and then renamed over it: a `mv` within one
# filesystem cannot leave a half-copied binary where the working one was, and
# renaming over a *running* binary is fine on Unix — the running process keeps
# the file it opened.
cp "$WORK/$NAME/bin/nomoreide" "$PREFIX/bin/nomoreide.new"
chmod 755 "$PREFIX/bin/nomoreide.new"
mv -f "$PREFIX/bin/nomoreide.new" "$PREFIX/bin/nomoreide"

# The dashboard is replaced rather than merged: assets are content-hashed, so
# merging would accumulate every version's files forever.
rm -rf "$PREFIX/share/nomoreide"
cp -R "$WORK/$NAME/share/nomoreide" "$PREFIX/share/nomoreide"

say "Installed $PREFIX/bin/nomoreide"

# ------------------------------------------------------------ diagnostics

case ":$PATH:" in
  *":$PREFIX/bin:"*) on_path=1 ;;
  *) on_path=0 ;;
esac

if [ "$on_path" -eq 0 ]; then
  say ""
  say "$PREFIX/bin is not on your PATH. Add it:"
  case "${SHELL##*/}" in
    zsh) note "echo 'export PATH=\"$PREFIX/bin:\$PATH\"' >> ~/.zshrc && exec zsh" ;;
    bash) note "echo 'export PATH=\"$PREFIX/bin:\$PATH\"' >> ~/.bashrc && exec bash" ;;
    fish) note "fish_add_path $PREFIX/bin" ;;
    *) note "export PATH=\"$PREFIX/bin:\$PATH\"" ;;
  esac
else
  found=$(command -v nomoreide 2>/dev/null || true)
  if [ -n "$found" ] && [ "$found" != "$PREFIX/bin/nomoreide" ]; then
    # Almost always the npm shim this replaces. Saying which one wins is the
    # difference between an upgrade that took and one that looks like it did.
    say ""
    say "Warning: \`nomoreide\` on your PATH is still $found, not the one just installed."
    note "Remove it (\`npm rm -g nomoreide\`) or put $PREFIX/bin earlier in PATH."
  fi
fi

# ------------------------------------------------------------ agent setup

# An agent counts as present if its CLI is on PATH or it already keeps a config
# here. Either alone is enough: someone can drive Claude Code from the desktop
# app with no `claude` on PATH, and someone can have just installed a CLI that
# has not written a config yet.
agent_present() {
  case "$1" in
    claude) command -v claude >/dev/null 2>&1 || [ -e "$HOME/.claude.json" ] || [ -d "$HOME/.claude" ] ;;
    codex)  command -v codex  >/dev/null 2>&1 || [ -d "$HOME/.codex" ] ;;
    gemini) command -v gemini >/dev/null 2>&1 || [ -d "$HOME/.gemini" ] ;;
    *) return 1 ;;
  esac
}

case "$SETUP" in
  none) wanted="" ;;
  auto)
    wanted=""
    for agent in claude codex gemini; do
      if agent_present "$agent"; then
        wanted="$wanted $agent"
      fi
    done
    ;;
  *)
    # An explicit list is a request, not a guess, so it is not filtered by
    # detection — naming an agent installs for it whether or not this can see
    # it. Already validated at parse time.
    wanted=$(printf '%s' "$SETUP" | tr ',' ' ')
    ;;
esac

if [ -n "$wanted" ]; then
  say ""
  # Failure here is reported, not fatal: the binary is installed and working,
  # and `setup` refuses rather than clobbers when it finds a different
  # nomoreide entry already in an agent's config. Turning that into a failed
  # install would throw away a good install over a config the user can fix.
  for agent in $wanted; do
    if "$PREFIX/bin/nomoreide" setup "$agent"; then
      :
    else
      say "Could not set up $agent automatically. Do it by hand:"
      note "$PREFIX/bin/nomoreide setup $agent --force"
    fi
  done
fi

say ""
say "Next:"
if [ -z "$wanted" ]; then
  note "nomoreide setup claude     # or codex, or gemini"
fi
note "nomoreide daemon           # the workbench on http://127.0.0.1:4317"

#!/bin/bash
# Phase 7 exit gate: "fresh-machine installation, upgrade, downgrade,
# uninstall, checksum failure, PATH diagnostics, and all three MCP client setup
# flows pass without Node.js."
#
# It builds a release the way `cli-release.yml` does — the same archive layout,
# the same SHA256SUMS — serves it over `file://`, and drives
# `apps/website/public/install.sh` against it. Two versions are built, so
# upgrade and downgrade move between real archives rather than reinstalling one.
#
# Everything the installer and the installed binary do runs with node, npm and
# npx absent from PATH.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BIN="${1:-$ROOT/target/debug/nomoreide}"
INSTALLER="$ROOT/apps/website/public/install.sh"
CLIENT="$ROOT/dist/web/client"

for required in "$BIN" "$INSTALLER"; do
  [ -e "$required" ] || { echo "missing $required" >&2; exit 2; }
done
[ -d "$CLIENT" ] || { echo "no built dashboard at $CLIENT — run \`npm run build\` first" >&2; exit 2; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/nomoreide-install-check-XXXXXX")
trap 'rm -rf "$WORK"' EXIT
CLEAN_PATH=/usr/bin:/bin:/usr/sbin:/sbin
OLD=9.9.8
NEW=9.9.9

pass=0; fail=0
ok()  { pass=$((pass+1)); printf "  ok   %s\n" "$1"; }
bad() { fail=$((fail+1)); printf "  FAIL %s — %s\n" "$1" "$2"; }

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi; }

# ---------------------------------------------------------- a fake release

host=$(uname -s)/$(uname -m)
case "$host" in
  Darwin/arm64) TARGET=aarch64-apple-darwin ;;
  Darwin/x86_64) TARGET=x86_64-apple-darwin ;;
  Linux/x86_64) TARGET=x86_64-unknown-linux-gnu ;;
  Linux/aarch64) TARGET=aarch64-unknown-linux-gnu ;;
  *) echo "this check has no release name for $host" >&2; exit 2 ;;
esac

RELEASE="$WORK/release"
build_release() {
  local version="$1" name="nomoreide-$1-$TARGET" dir
  dir="$WORK/stage/$name"
  mkdir -p "$dir/bin" "$dir/share/nomoreide/web"
  cp "$BIN" "$dir/bin/nomoreide"
  cp -R "$CLIENT" "$dir/share/nomoreide/web/client"
  printf '%s\n%s\n%s\n' "$version" "check-install" "$TARGET" > "$dir/share/nomoreide/build-info.txt"
  mkdir -p "$RELEASE/download/v$version"
  tar -C "$WORK/stage" -czf "$RELEASE/download/v$version/$name.tar.gz" "$name"
  (cd "$RELEASE/download/v$version" && sha "$name.tar.gz" > SHA256SUMS)
}
build_release "$OLD"
build_release "$NEW"
# What the GitHub API answers with, reduced to the one field the installer reads.
printf '{"tag_name":"v%s","name":"NoMoreIDE %s"}\n' "$NEW" "$NEW" > "$RELEASE/latest.json"

PREFIX="$WORK/prefix"
installer() {
  env -i PATH="$CLEAN_PATH" HOME="$WORK/home" SHELL=/bin/zsh \
      NOMOREIDE_BASE_URL="file://$RELEASE" \
      NOMOREIDE_API_URL="file://$RELEASE/latest.json" \
      sh "$INSTALLER" "$@" 2>&1
}
mkdir -p "$WORK/home"

# ---------------------------------------------------------- fresh install

out=$(installer --version "$OLD" --prefix "$PREFIX"); code=$?
if [ "$code" -eq 0 ] && [ -x "$PREFIX/bin/nomoreide" ]; then
  ok "a fresh install puts a runnable binary in the prefix"
else
  bad "fresh install" "exit $code: $(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
fi
case "$out" in *"checksum ok"*) ok "it verified the archive before unpacking it" ;;
  *) bad "checksum reported" "no 'checksum ok' in the output" ;; esac
[ -f "$PREFIX/share/nomoreide/web/client/index.html" ] \
  && ok "the dashboard is installed beside it under share/" \
  || bad "dashboard files" "no index.html under $PREFIX/share/nomoreide/web/client"
version_installed() { head -1 "$PREFIX/share/nomoreide/build-info.txt" 2>/dev/null; }
[ "$(version_installed)" = "$OLD" ] && ok "it installed the version asked for ($OLD)" \
  || bad "version" "build-info says $(version_installed), wanted $OLD"

# The installed binary runs with no Node anywhere.
if env -i PATH="$CLEAN_PATH" HOME="$WORK/home" "$PREFIX/bin/nomoreide" setup 2>&1 | grep -q "nomoreide setup claude"; then
  ok "the installed binary runs with node absent from PATH"
else
  bad "installed binary" "\`nomoreide setup\` printed nothing recognisable"
fi

# ------------------------------------------- the daemon serves its dashboard
# The reason `asset_roots()` learned about `<prefix>/share`: an installed
# binary is not inside a checkout, so nothing else would find the client.
PORT=47517
while (echo >"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; do
  PORT=$((PORT + 1))
  [ "$PORT" -gt 47600 ] && { echo "no free port in 47517-47600" >&2; exit 2; }
done
DHOME="$WORK/daemon-home"; mkdir -p "$DHOME"
env -i PATH="$CLEAN_PATH" HOME="$DHOME" XDG_CONFIG_HOME="$DHOME/.config" \
    NOMOREIDE_AUTO_UI=0 NOMOREIDE_DAEMON_PORT="$PORT" \
    "$PREFIX/bin/nomoreide" daemon > "$WORK/daemon.out" 2>&1 &
DAEMON=$!
trap 'kill $DAEMON 2>/dev/null; rm -rf "$WORK"' EXIT
ready=0
for _ in $(seq 1 60); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/health" && { ready=1; break; }
  kill -0 "$DAEMON" 2>/dev/null || break
  sleep 0.5
done
if [ "$ready" -eq 1 ]; then
  body=$(curl -s "http://127.0.0.1:$PORT/")
  case "$body" in
    *"<div id=\"root\""*|*"<div id=root"*) ok "the installed daemon serves the dashboard from share/" ;;
    *) bad "installed dashboard" "served $(printf '%s' "$body" | head -c 80)" ;;
  esac
else
  bad "installed daemon" "never answered /api/health; $(tail -2 "$WORK/daemon.out" | tr '\n' ' ')"
fi
kill $DAEMON 2>/dev/null
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------- three setup flows

SETUP_HOME="$WORK/agent-home"; mkdir -p "$SETUP_HOME"
for agent in claude codex gemini; do
  out=$(env -i PATH="$CLEAN_PATH" HOME="$SETUP_HOME" XDG_CONFIG_HOME="$SETUP_HOME/.config" \
        "$PREFIX/bin/nomoreide" setup "$agent" 2>&1); code=$?
  [ "$code" -eq 0 ] || { bad "setup $agent" "exit $code: $out"; continue; }
  case "$out" in
    *"MCP added"*) ok "setup $agent installs the MCP server" ;;
    *) bad "setup $agent" "did not report the MCP as added: $out" ;;
  esac
done
# What it wrote must name the installed binary — not npx, and not a relative
# name an agent with a different PATH would fail to resolve.
for file in "$SETUP_HOME/.claude.json" "$SETUP_HOME/.codex/config.toml" "$SETUP_HOME/.gemini/settings.json"; do
  short=${file#"$SETUP_HOME/"}
  if grep -q "$PREFIX/bin/nomoreide" "$file" 2>/dev/null; then
    if grep -q "npx" "$file" 2>/dev/null; then
      bad "$short" "still mentions npx"
    else
      ok "$short names the installed binary and no package runner"
    fi
  else
    bad "$short" "does not name $PREFIX/bin/nomoreide"
  fi
done
for skill in "$SETUP_HOME/.claude/skills/nomoreide-debug/SKILL.md" \
             "$SETUP_HOME/.agents/skills/nomoreide-debug/SKILL.md" \
             "$SETUP_HOME/.gemini/skills/nomoreide-debug/SKILL.md"; do
  [ -s "$skill" ] && ok "the skill is installed at ${skill#"$SETUP_HOME/"}" \
    || bad "skill" "missing ${skill#"$SETUP_HOME/"}"
done

# --------------------------------------------- the installer does it too

# The point of `--setup` is that one command leaves a working agent, so this
# drives the installer rather than the binary: a separate home, a separate
# prefix, and afterwards the agent's own config must name the binary that was
# just installed into that prefix.
# All three at once, through `auto`, because "one command and every agent I
# use is ready" is the actual promise — not "one command and one agent". The
# home is seeded with each agent's directory so detection finds all three
# without needing their CLIs on this PATH.
ONE_GO_HOME="$WORK/one-go-home"
mkdir -p "$ONE_GO_HOME/.claude" "$ONE_GO_HOME/.codex" "$ONE_GO_HOME/.gemini"
ONE_GO_PREFIX="$WORK/one-go-prefix"
out=$(env -i PATH="$CLEAN_PATH" HOME="$ONE_GO_HOME" SHELL=/bin/zsh \
      NOMOREIDE_BASE_URL="file://$RELEASE" \
      NOMOREIDE_API_URL="file://$RELEASE/latest.json" \
      sh "$INSTALLER" --version "$NEW" --prefix "$ONE_GO_PREFIX" 2>&1); code=$?
if [ "$code" -eq 0 ]; then
  ok "the installer exits 0 with every agent present"
else
  bad "installer --setup auto" "exit $code: $out"
fi
for file in .claude.json .codex/config.toml .gemini/settings.json; do
  if grep -q "$ONE_GO_PREFIX/bin/nomoreide" "$ONE_GO_HOME/$file" 2>/dev/null; then
    ok "one command registered the MCP in $file"
  else
    bad "installer --setup auto" "did not register the MCP in $file: $out"
  fi
done
# The skill is half of what `setup` installs, and a registration without it
# leaves the agent able to call the tools but not knowing when to.
for skill in .claude/skills .agents/skills .gemini/skills; do
  [ -s "$ONE_GO_HOME/$skill/nomoreide-debug/SKILL.md" ] \
    && ok "one command installed the skill at $skill" \
    || bad "installer --setup auto" "no skill at $skill"
done

# An explicit list is honoured over detection, and installs only what it names.
PICK_HOME="$WORK/pick-home"; mkdir -p "$PICK_HOME/.claude" "$PICK_HOME/.codex"
PICK_PREFIX="$WORK/pick-prefix"
out=$(env -i PATH="$CLEAN_PATH" HOME="$PICK_HOME" SHELL=/bin/zsh \
      NOMOREIDE_BASE_URL="file://$RELEASE" \
      NOMOREIDE_API_URL="file://$RELEASE/latest.json" \
      sh "$INSTALLER" --version "$NEW" --prefix "$PICK_PREFIX" --setup codex 2>&1); code=$?
if [ "$code" -eq 0 ] && grep -q "$PICK_PREFIX/bin/nomoreide" "$PICK_HOME/.codex/config.toml" 2>/dev/null \
   && [ ! -e "$PICK_HOME/.claude.json" ]; then
  ok "--setup codex installs for codex only, though claude is present too"
else
  bad "--setup codex" "expected codex configured and claude untouched (exit $code): $out"
fi

# `auto` in an environment with no agent must be a silent no-op, not a guess:
# writing a config for an agent that is not there is worse than not writing
# one, because it is a file the user did not ask for and will not look in.
AUTO_HOME="$WORK/auto-home"; mkdir -p "$AUTO_HOME"
AUTO_PREFIX="$WORK/auto-prefix"
out=$(env -i PATH="$CLEAN_PATH" HOME="$AUTO_HOME" SHELL=/bin/zsh \
      NOMOREIDE_BASE_URL="file://$RELEASE" \
      NOMOREIDE_API_URL="file://$RELEASE/latest.json" \
      sh "$INSTALLER" --version "$NEW" --prefix "$AUTO_PREFIX" 2>&1); code=$?
if [ "$code" -eq 0 ] && [ ! -e "$AUTO_HOME/.claude.json" ] \
   && [ ! -e "$AUTO_HOME/.codex/config.toml" ] && [ ! -e "$AUTO_HOME/.gemini/settings.json" ]; then
  ok "the default --setup auto writes nothing when no agent is installed"
else
  bad "--setup auto" "wrote an agent config with no agent present (exit $code): $out"
fi

# A misspelled agent is a usage error and must be refused before anything is
# downloaded, let alone installed.
BAD_PREFIX="$WORK/bad-prefix"
out=$(env -i PATH="$CLEAN_PATH" HOME="$WORK/home" SHELL=/bin/zsh \
      NOMOREIDE_BASE_URL="file://$RELEASE" \
      NOMOREIDE_API_URL="file://$RELEASE/latest.json" \
      sh "$INSTALLER" --prefix "$BAD_PREFIX" --setup nosuchagent 2>&1); code=$?
if [ "$code" -eq 2 ] && [ ! -e "$BAD_PREFIX/bin/nomoreide" ]; then
  ok "--setup with an unknown agent exits 2 and installs nothing"
else
  bad "--setup nosuchagent" "expected exit 2 and no install, got exit $code: $out"
fi

# ------------------------------------------------------------- upgrade

out=$(installer --version "$NEW" --prefix "$PREFIX"); code=$?
[ "$code" -eq 0 ] && [ "$(version_installed)" = "$NEW" ] \
  && ok "an upgrade over an existing install lands ($OLD -> $NEW)" \
  || bad "upgrade" "exit $code, build-info says $(version_installed)"

# Resolving "latest" is its own step: everything above named a version.
rm -rf "$PREFIX"
out=$(installer --prefix "$PREFIX"); code=$?
[ "$code" -eq 0 ] && [ "$(version_installed)" = "$NEW" ] \
  && ok "with no --version it resolves the latest release ($NEW)" \
  || bad "latest" "exit $code, build-info says $(version_installed)"

# ------------------------------------------------------------ downgrade

out=$(installer --version "$OLD" --prefix "$PREFIX"); code=$?
[ "$code" -eq 0 ] && [ "$(version_installed)" = "$OLD" ] \
  && ok "a downgrade to an older release lands ($NEW -> $OLD)" \
  || bad "downgrade" "exit $code, build-info says $(version_installed)"

# --------------------------------------------------------- checksum failure

BAD=9.9.7
build_release "$BAD"
# One byte of the archive, after the checksum was taken: exactly what a
# corrupted or tampered download looks like.
printf 'x' >> "$RELEASE/download/v$BAD/nomoreide-$BAD-$TARGET.tar.gz"
before=$(version_installed)
out=$(installer --version "$BAD" --prefix "$PREFIX"); code=$?
if [ "$code" -eq 1 ]; then
  ok "a bad checksum exits 1"
else
  bad "checksum failure" "exited $code, wanted 1"
fi
case "$out" in *"checksum mismatch"*) ok "and says so plainly" ;;
  *) bad "checksum message" "no 'checksum mismatch' in: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')" ;; esac
[ "$(version_installed)" = "$before" ] \
  && ok "and leaves the working install alone" \
  || bad "checksum failure" "the install changed to $(version_installed)"

# A SHA256SUMS that simply does not list our archive is the same refusal.
rm -f "$RELEASE/download/v$BAD/SHA256SUMS"; : > "$RELEASE/download/v$BAD/SHA256SUMS"
out=$(installer --version "$BAD" --prefix "$PREFIX"); code=$?
[ "$code" -eq 1 ] && ok "an unlisted archive is refused rather than trusted" \
  || bad "unlisted archive" "exited $code, wanted 1"

# ------------------------------------------------------ unwritable prefix

# `set -e` would otherwise report this as a bare mkdir error from a script the
# user piped in and cannot read back.
out=$(installer --version "$OLD" --prefix /nomoreide-check-cannot-write); code=$?
if [ "$code" -eq 1 ]; then
  case "$out" in
    *"cannot create"*|*"not writable"*) ok "an unwritable prefix is refused with something actionable" ;;
    *) bad "unwritable prefix" "exited 1 but said: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')" ;;
  esac
else
  bad "unwritable prefix" "exited $code, wanted 1"
fi

# ------------------------------------------------------- PATH diagnostics

out=$(installer --version "$OLD" --prefix "$PREFIX")
case "$out" in
  *"is not on your PATH"*) ok "it says so when the prefix is not on PATH" ;;
  *) bad "PATH diagnostic" "no warning, though $PREFIX/bin is not on the clean PATH" ;;
esac
case "$out" in *".zshrc"*) ok "and names the file for the user's shell" ;;
  *) bad "PATH diagnostic" "did not name a zsh rc file for SHELL=/bin/zsh" ;; esac

# A different `nomoreide` earlier on PATH — the npm shim, in practice — is the
# one failure that otherwise looks exactly like success.
SHADOW="$WORK/shadow"; mkdir -p "$SHADOW"
printf '#!/bin/sh\necho other\n' > "$SHADOW/nomoreide"; chmod +x "$SHADOW/nomoreide"
out=$(env -i PATH="$SHADOW:$PREFIX/bin:$CLEAN_PATH" HOME="$WORK/home" SHELL=/bin/bash \
      NOMOREIDE_BASE_URL="file://$RELEASE" NOMOREIDE_API_URL="file://$RELEASE/latest.json" \
      sh "$INSTALLER" --version "$OLD" --prefix "$PREFIX" 2>&1)
case "$out" in
  *"is still $SHADOW/nomoreide"*) ok "it warns when another nomoreide shadows the new one" ;;
  *) bad "shadow diagnostic" "no warning about $SHADOW/nomoreide" ;;
esac
# And stays quiet when the installed one is the one that wins.
out=$(env -i PATH="$PREFIX/bin:$CLEAN_PATH" HOME="$WORK/home" SHELL=/bin/bash \
      NOMOREIDE_BASE_URL="file://$RELEASE" NOMOREIDE_API_URL="file://$RELEASE/latest.json" \
      sh "$INSTALLER" --version "$OLD" --prefix "$PREFIX" 2>&1)
case "$out" in
  *"is not on your PATH"*|*"is still"*) bad "quiet path" "warned anyway: $(printf '%s' "$out" | tail -3 | tr '\n' ' ')" ;;
  *) ok "and says nothing about PATH when the prefix already wins" ;;
esac

# ------------------------------------------------------------- uninstall

out=$(installer --uninstall --prefix "$PREFIX"); code=$?
if [ "$code" -eq 0 ] && [ ! -e "$PREFIX/bin/nomoreide" ] && [ ! -d "$PREFIX/share/nomoreide" ]; then
  ok "uninstall removes the binary and its assets"
else
  bad "uninstall" "exit $code, binary $( [ -e "$PREFIX/bin/nomoreide" ] && echo present || echo gone )"
fi
# The agent configs are the user's; an uninstall that deleted MCP servers it
# never wrote would be taking away more than it gave.
[ -s "$SETUP_HOME/.claude.json" ] && ok "and leaves the agent configs alone" \
  || bad "uninstall" "the agent config was removed"
out=$(installer --uninstall --prefix "$PREFIX"); code=$?
[ "$code" -eq 0 ] && case "$out" in *"Nothing installed"*) ok "a second uninstall is a no-op, not an error" ;;
  *) bad "second uninstall" "said: $out" ;; esac

# ----------------------------------------------------------------- usage

env -i PATH="$CLEAN_PATH" HOME="$WORK/home" sh "$INSTALLER" --help >/dev/null 2>&1 \
  && ok "--help exits 0" || bad "--help" "non-zero exit"
env -i PATH="$CLEAN_PATH" HOME="$WORK/home" sh "$INSTALLER" --nonsense >/dev/null 2>&1
[ $? -eq 2 ] && ok "an unknown option exits 2" || bad "unknown option" "did not exit 2"
env -i PATH="$CLEAN_PATH" HOME="$WORK/home" sh "$INSTALLER" --version >/dev/null 2>&1
[ $? -eq 2 ] && ok "--version with nothing after it exits 2" || bad "--version" "did not exit 2"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

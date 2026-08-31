#!/bin/bash
# Phase 6 exit gate: "the complete product runs on a machine with no Node.js
# installed. Node remains only a build-time dependency for frontend assets and
# tests." So this drives the built binary with node, npm, npx and tsx absent
# from PATH — and uses only curl and the shell, so the check itself does not
# reintroduce what it is testing for.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BIN="${1:-$ROOT/target/debug/nomoreide}"
if [ ! -x "$BIN" ]; then
  echo "no binary at $BIN — run \`cargo build\` first" >&2
  exit 2
fi
HOME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/nomoreide-nonode-XXXXXX")
CLEAN_PATH=/usr/bin:/bin:/usr/sbin:/sbin

# A port nothing else here is holding: this starts a real daemon, and colliding
# with the developer's own would both fail the check and confuse them.
PORT=47317
while (echo >"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; do
  PORT=$((PORT + 1))
  [ "$PORT" -gt 47400 ] && { echo "no free port in 47317-47400" >&2; exit 2; }
done
pass=0; fail=0
ok()   { pass=$((pass+1)); printf "  ok   %s\n" "$1"; }
bad()  { fail=$((fail+1)); printf "  FAIL %s — %s\n" "$1" "$2"; }

env -i PATH="$CLEAN_PATH" HOME="$HOME_DIR" XDG_CONFIG_HOME="$HOME_DIR/.config" \
    NOMOREIDE_AUTO_UI=0 NOMOREIDE_DAEMON_PORT="$PORT" \
    "$BIN" daemon > "$HOME_DIR/daemon.out" 2>&1 &
DAEMON=$!
trap 'kill $DAEMON 2>/dev/null; rm -rf "$HOME_DIR"' EXIT

BASE="http://127.0.0.1:$PORT"
ready=0
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "$BASE/api/health"; then ready=1; break; fi
  kill -0 "$DAEMON" 2>/dev/null || break
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "the daemon never answered /api/health on port $PORT; its output was:" >&2
  cat "$HOME_DIR/daemon.out" >&2
  exit 1
fi

CRED="$HOME_DIR/.nomoreide/daemon.credential"
[ -s "$CRED" ] && ok "the daemon minted its credential" || bad "credential" "no $CRED"
TOKEN=$(cat "$CRED" 2>/dev/null)
auth=(-H "Authorization: Bearer $TOKEN")

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health")
[ "$code" = "200" ] && ok "/api/health answers 200 with no node on PATH" || bad "/api/health" "got $code"

# The dashboard itself: the daemon serves the built client from dist/ on disk,
# which is the half Node is still allowed to have produced at build time.
body=$(curl -s "$BASE/")
case "$body" in
  *"<div id=\"root\""*|*"<div id=root"*) ok "the dashboard shell is served" ;;
  *) bad "dashboard" "no root element in $(printf '%s' "$body" | head -c 60)" ;;
esac
asset=$(printf '%s' "$body" | sed -n 's/.*src="\(\/assets\/[^"]*\.js\)".*/\1/p' | head -1)
if [ -n "$asset" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$asset")
  [ "$code" = "200" ] && ok "its javascript bundle is served ($asset)" || bad "bundle" "got $code for $asset"
else
  bad "bundle" "no asset reference in the shell"
fi

# Real GET routes, each asserted to be 200. An earlier version of this check
# accepted 404 as well, which made it vacuous: three of the paths it listed do
# not exist in the reference either, so it was passing on the daemon's SPA
# fallback rather than on any route being served.
for route in /api/services /api/databases /api/dashboard /api/errors /api/extensions              /api/agent-env/agents /api/agent-env/doctor /api/agent/usage              /api/git/status /api/git/worktrees /api/context /api/docker/status; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "$BASE$route")
  [ "$code" = "200" ] && ok "GET $route -> 200" || bad "GET $route" "got $code, wanted 200"
done

# And one route that must NOT exist, so a daemon answering everything with the
# SPA shell cannot pass the block above by accident.
code=$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "$BASE/api/definitely-not-a-route")
[ "$code" = "404" ] && ok "an unknown /api path is still 404" || bad "unknown route" "got $code, wanted 404"

# The agent surface, over stdio, with the same empty PATH.
mcp=$(printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"no-node","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | env -i PATH="$CLEAN_PATH" HOME="$HOME_DIR" XDG_CONFIG_HOME="$HOME_DIR/.config" \
      NOMOREIDE_AUTO_UI=0 NOMOREIDE_DAEMON_PORT="$PORT" "$BIN" mcp 2>/dev/null)
tools=$(printf '%s' "$mcp" | tr ',' '\n' | grep -c '"name":')
[ "$tools" -gt 60 ] && ok "nomoreide mcp lists $tools tools over stdio" || bad "mcp tools/list" "saw $tools tool names"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

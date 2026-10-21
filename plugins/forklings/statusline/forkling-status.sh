#!/bin/sh
# Claude Code status line: two short lines with your Forkling's mood and needs.
# Reads the token from $FORKLINGS_TOKEN or ~/.config/forklings/token, and caches the
# answer for a minute so the status line never waits on the network.
# Setup: docs/claude-code.md in the forklings repository.

cat >/dev/null # Claude Code sends session JSON on stdin; this line doesn't need it.

token=${FORKLINGS_TOKEN:-}
[ -z "$token" ] && [ -r "$HOME/.config/forklings/token" ] && token=$(tr -d ' \n' <"$HOME/.config/forklings/token")
[ -z "$token" ] && { echo "forkling: set FORKLINGS_TOKEN"; exit 0; }

cache_dir=${XDG_CACHE_HOME:-$HOME/.cache}/forklings
cache=$cache_dir/status
mkdir -p "$cache_dir"

fresh=$(find "$cache" -mmin -1 2>/dev/null)
if [ -z "$fresh" ]; then
  tmp=$cache.$$
  if curl -fsS --max-time 2 -H "Authorization: Bearer $token" "${FORKLINGS_URL:-https://forklings.dev}/api/status-line" >"$tmp" 2>/dev/null; then
    mv "$tmp" "$cache"
  else
    rm -f "$tmp"
    [ -f "$cache" ] || { echo "forkling: offline"; exit 0; }
  fi
fi
cat "$cache"

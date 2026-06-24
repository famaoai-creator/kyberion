#!/usr/bin/env bash
# Native messaging launcher for the Kyberion Browser Bridge host.
# Chrome execs this with the extension's stdio attached and a MINIMAL PATH, so we
# must resolve the node binary explicitly (install.sh pins it in .node-path).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

NODE_BIN=""
if [ -f "$SCRIPT_DIR/.node-path" ]; then
  NODE_BIN="$(cat "$SCRIPT_DIR/.node-path")"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.volta/bin/node \
    "$HOME"/.fnm/node-versions/*/installation/bin/node; do
    if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
  done
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "Kyberion Browser Bridge: node binary not found" >&2
  exit 1
fi

exec "$NODE_BIN" "$REPO_ROOT/dist/scripts/browser_bridge_host.js"

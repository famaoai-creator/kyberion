#!/usr/bin/env bash
# Native messaging launcher for the Kyberion Browser Bridge host.
# Chrome execs this with the extension's stdio attached and a MINIMAL PATH, so we
# must resolve the node binary explicitly (install.sh pins it in .node-path).
#
# Diagnostics: breadcrumbs go to ~/Library/Logs/kyberion-browser-bridge.log — a
# TCC-free location — BEFORE anything that can fail (external-volume access,
# node resolution), so a silent early death is still visible.

BREADCRUMB="${HOME:-/tmp}/Library/Logs/kyberion-browser-bridge.log"
mkdir -p "$(dirname "$BREADCRUMB")" 2>/dev/null || BREADCRUMB=/dev/null
crumb() { echo "$(date '+%Y-%m-%dT%H:%M:%S%z') pid=$$ $*" >> "$BREADCRUMB" 2>/dev/null; }
crumb "launch.sh started (cwd=$(pwd 2>/dev/null || echo '?'), arg0=$0)"

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [ -z "$SCRIPT_DIR" ]; then
  crumb "FATAL: cannot cd into script dir — external volume unreadable (TCC?)"
  exit 1
fi
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." 2>/dev/null && pwd)"
if [ -z "$REPO_ROOT" ]; then
  crumb "FATAL: cannot resolve repo root from $SCRIPT_DIR"
  exit 1
fi
crumb "resolved SCRIPT_DIR=$SCRIPT_DIR REPO_ROOT=$REPO_ROOT"

NODE_BIN=""
if [ -f "$SCRIPT_DIR/.node-path" ]; then
  NODE_BIN="$(cat "$SCRIPT_DIR/.node-path" 2>/dev/null)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "${HOME:-/nonexistent}"/.nvm/versions/node/*/bin/node \
    "${HOME:-/nonexistent}"/.volta/bin/node \
    "${HOME:-/nonexistent}"/.fnm/node-versions/*/installation/bin/node; do
    if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
  done
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  crumb "FATAL: node binary not found"
  echo "Kyberion Browser Bridge: node binary not found" >&2
  exit 1
fi
crumb "node=$NODE_BIN"

if [ ! -r "$REPO_ROOT/dist/scripts/browser_bridge_host.js" ]; then
  crumb "FATAL: host js unreadable: $REPO_ROOT/dist/scripts/browser_bridge_host.js"
  exit 1
fi

# Chrome launches native hosts with an arbitrary cwd (not the repo). The host's
# path resolver walks up from cwd to find the repo root, so pin both the env
# override and the cwd to keep cwd-relative resolution working.
export KYBERION_ROOT="$REPO_ROOT"
cd "$REPO_ROOT" || { crumb "FATAL: cannot cd to repo root"; exit 1; }

# stderr is invisible when Chrome launches us — keep the last run's diagnostics.
# Prefer the repo tmp dir; fall back to the breadcrumb log.
LOG_FILE="$BREADCRUMB"
if mkdir -p "$REPO_ROOT/active/shared/tmp" 2>/dev/null \
  && touch "$REPO_ROOT/active/shared/tmp/.browser-bridge-host.probe" 2>/dev/null; then
  rm -f "$REPO_ROOT/active/shared/tmp/.browser-bridge-host.probe" 2>/dev/null
  LOG_FILE="$REPO_ROOT/active/shared/tmp/browser-bridge-host.stderr.log"
fi
crumb "exec node (stderr -> $LOG_FILE)"
exec "$NODE_BIN" "$REPO_ROOT/dist/scripts/browser_bridge_host.js" 2>> "$LOG_FILE"

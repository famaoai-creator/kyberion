#!/usr/bin/env bash
# Register the Kyberion Browser Bridge native messaging host for Chrome/Chromium.
#
# Usage:
#   tools/adf-replay-extension/native-host/install.sh <CHROME_EXTENSION_ID>
#
# Find the extension ID at chrome://extensions (Developer mode → the unpacked
# "Kyberion Browser Bridge" card). Re-run after rebuilding or if the ID changes.
set -euo pipefail

EXT_ID="${1:-}"
if [ -z "$EXT_ID" ]; then
  echo "Usage: $0 <chrome-extension-id>  (copy it from chrome://extensions)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LAUNCHER="$SCRIPT_DIR/launch.sh"
HOST_NAME="com.kyberion.browser_bridge"
HOST_JS="$REPO_ROOT/dist/scripts/browser_bridge_host.js"

# Preconditions ---------------------------------------------------------------
if [ ! -f "$HOST_JS" ]; then
  echo "Host not built: $HOST_JS missing. Run 'pnpm build' (or 'npx tsc') first." >&2
  exit 1
fi
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH; install Node or activate your version manager." >&2
  exit 1
fi
chmod +x "$LAUNCHER"
# Pin node so Chrome's minimal launch PATH can still locate it.
printf '%s' "$NODE_BIN" > "$SCRIPT_DIR/.node-path"

# Manifest --------------------------------------------------------------------
MANIFEST=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Kyberion Browser Bridge native messaging host",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
)

# Install into every Chrome/Chromium profile dir that exists -------------------
TARGET_DIRS=(
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
  "$HOME/.config/google-chrome/NativeMessagingHosts"
  "$HOME/.config/chromium/NativeMessagingHosts"
)

installed=0
for dir in "${TARGET_DIRS[@]}"; do
  parent="$(dirname "$dir")"
  if [ -d "$parent" ]; then
    mkdir -p "$dir"
    printf '%s\n' "$MANIFEST" > "$dir/$HOST_NAME.json"
    echo "installed → $dir/$HOST_NAME.json"
    installed=1
  fi
done

if [ "$installed" -eq 0 ]; then
  echo "No Chrome/Chromium profile directory found. Is the browser installed for this user?" >&2
  exit 1
fi

echo "node:      $NODE_BIN"
echo "launcher:  $LAUNCHER"
echo "extension: $EXT_ID"
echo "Done. Fully quit and reopen Chrome (or reload the extension), then retry execution."

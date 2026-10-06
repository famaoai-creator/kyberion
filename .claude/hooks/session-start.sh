#!/bin/bash
# Cloud-session bootstrap (Claude Code on the web only).
# Puts Node >=24 on PATH and makes sure `dist/` matches HEAD, so the session-start
# baseline check (`pnpm pipeline --input pipelines/baseline-check.json`) can run.
# See docs/developer/CLOUD_AGENT_ENVIRONMENT.md.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

# Node 24 via the container's nvm (cached in the container snapshot after the first run).
export NVM_DIR="${NVM_DIR:-/opt/nvm}"
# shellcheck disable=SC1091
source "$NVM_DIR/nvm.sh"
nvm install 24 >/dev/null
nvm alias default 24 >/dev/null
NODE_BIN="$(dirname "$(nvm which 24)")"
export PATH="$NODE_BIN:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack enable

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export PATH=\"$NODE_BIN:\$PATH\""
    echo "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0"
  } >> "$CLAUDE_ENV_FILE"
fi

pnpm install --prefer-offline

# Rebuild only when dist/ was not built from the current HEAD (a full build takes minutes).
STAMP="dist/.session-build-head"
HEAD_SHA="$(git rev-parse HEAD)"
if [ ! -f dist/scripts/run_pipeline.js ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$HEAD_SHA" ]; then
  pnpm build
  echo "$HEAD_SHA" > "$STAMP"
fi

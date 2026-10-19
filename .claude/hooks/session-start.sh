#!/bin/bash
# Cloud-session bootstrap (Claude Code on the web only).
# Puts Node >=24 on PATH and makes sure `dist/` matches HEAD, so the session-start
# baseline check (`pnpm pipeline --input pipelines/baseline-check.json`) can run.
# See docs/developer/CLOUD_AGENT_ENVIRONMENT.md ("Diagnosing session-start failures").
#
# Failures must be visible: every failing command is reported on stderr with its
# line and a next step, and the full output of install/build goes to the log file
# below (storage-layout scratch floor, system partition).
set -Eeuo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

LOG_DIR="active/shared/tmp/system/session-start"
LOG_FILE="$LOG_DIR/session-start.log"
mkdir -p "$LOG_DIR"
: > "$LOG_FILE"

say() {
  echo "[session-start] $*" >&2
  echo "[session-start] $*" >> "$LOG_FILE"
}

on_error() {
  local status=$1 line=$2 command=$3
  trap - ERR
  {
    echo "[session-start] FAILED (exit $status) at .claude/hooks/session-start.sh:$line: $command"
    echo "[session-start] Log: $LOG_FILE (last lines below)"
    tail -n 20 "$LOG_FILE" 2>/dev/null | sed 's/^/[session-start]   /'
    echo "[session-start] Next: fix the cause, then run \`bash .claude/hooks/session-start.sh\`" \
      "(or \`pnpm install --prefer-offline\` then \`pnpm build\` as separate commands)." \
      "The Kyberion PreToolUse hook allows exactly these while dist/ is missing."
  } >&2
  exit "$status"
}
trap 'on_error $? $LINENO "$BASH_COMMAND"' ERR

node_major() {
  "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

# 1. Node >= 24: already on PATH, then nvm, then any /opt/node*/ install.
NODE_BIN=""
if command -v node > /dev/null 2>&1 && [ "$(node_major "$(command -v node)")" -ge 24 ]; then
  NODE_BIN="$(dirname "$(command -v node)")"
fi

export NVM_DIR="${NVM_DIR:-/opt/nvm}"
if [ -z "$NODE_BIN" ] && [ -s "$NVM_DIR/nvm.sh" ]; then
  # nvm.sh is not strict-mode safe: with `set -eu` its auto-`use` returns 3 when no
  # default version is installed and kills this script silently. Source it with
  # strict mode and the ERR trap off, and never let nvm decide the exit status.
  set +Eeu
  trap - ERR
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" --no-use >> "$LOG_FILE" 2>&1
  if nvm install 24 >> "$LOG_FILE" 2>&1; then
    nvm alias default 24 >> "$LOG_FILE" 2>&1
    candidate="$(nvm which 24 2>> "$LOG_FILE")"
    if [ -x "$candidate" ]; then
      NODE_BIN="$(dirname "$candidate")"
    fi
  else
    echo "[session-start] nvm install 24 failed (see log above)" >> "$LOG_FILE"
  fi
  set -Eeu
  trap 'on_error $? $LINENO "$BASH_COMMAND"' ERR
fi

if [ -z "$NODE_BIN" ]; then
  for candidate in /opt/node*/bin/node; do
    if [ -x "$candidate" ] && [ "$(node_major "$candidate")" -ge 24 ]; then
      NODE_BIN="$(dirname "$candidate")"
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  if ! command -v node > /dev/null 2>&1; then
    say "FAILED: no Node.js found (nvm at $NVM_DIR could not install Node 24; see $LOG_FILE)."
    say "Next: install Node 24, then run \`bash .claude/hooks/session-start.sh\`."
    exit 1
  fi
  NODE_BIN="$(dirname "$(command -v node)")"
  say "WARNING: Node 24 could not be obtained; continuing with $(node -v) from $NODE_BIN." \
    "Expect engine warnings; Node-24-only features may fail. Details: $LOG_FILE"
fi

export PATH="$NODE_BIN:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
say "Using node $(node -v) from $NODE_BIN"
if ! corepack enable >> "$LOG_FILE" 2>&1; then
  say "WARNING: corepack enable failed; relying on pnpm already on PATH."
fi
command -v pnpm > /dev/null 2>&1 || {
  say "FAILED: pnpm is not on PATH after corepack enable. Next: install pnpm, then rerun this hook."
  exit 1
}

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export PATH=\"$NODE_BIN:\$PATH\""
    echo "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0"
  } >> "$CLAUDE_ENV_FILE"
fi

# 2. Dependencies and dist/ (install/build output goes to the log, not the session context).
say "pnpm install --prefer-offline (log: $LOG_FILE)"
pnpm install --prefer-offline >> "$LOG_FILE" 2>&1

# Rebuild only when dist/ was not built from the current HEAD (a full build takes minutes).
STAMP="dist/.session-build-head"
HEAD_SHA="$(git rev-parse HEAD)"
if [ ! -f dist/scripts/run_pipeline.js ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$HEAD_SHA" ]; then
  say "pnpm build (log: $LOG_FILE)"
  pnpm build >> "$LOG_FILE" 2>&1
  echo "$HEAD_SHA" > "$STAMP"
fi
say "ready: node $(node -v), dist/ built from ${HEAD_SHA:0:12}"

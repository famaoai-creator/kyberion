---
title: Cloud Agent environment notes
tags: [cloud-agent, node, build, operator, environment]
last_updated: 2026-10-19
---

# Cloud Agent / Linux VM environment

This is **operator/dev environment guidance**, not a product-runtime change. It does not alter `package.json` `engines` and does not claim to fix CI images unless this repo owns that config.

## Floor

| Requirement                       | Why                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node `>=24`**                   | `package.json` `engines.node` is `>=24.0.0`. Node 22 cannot load the TypeScript harness (`registerHooks`) and cannot consume `@agent/core` dist exports cleanly. |
| **`pnpm build` before execution** | Official probes (`pnpm pipeline`, `pnpm mcp:server`, `pnpm run doctor`, `pnpm kyberion run`) read `dist/`. Discovery without build is the exception.             |

## What works without `dist/`

- `pnpm capabilities` / `pnpm kyberion list` — `scripts/capability_discovery_entry.mjs` (manifest scan, including Node 22)
- `pnpm playground -- --dry-run --json` — source playground (`tsx`), still needs `@agent/core` resolution for schema validation

## What needs the build

```bash
# Use Node 24+ (nvm example)
nvm install 24 && nvm use 24

pnpm install
pnpm build

pnpm pipeline --input pipelines/baseline-check.json
pnpm run doctor          # not bare `pnpm doctor` (that is pnpm's own doctor)
```

If `dist/scripts/kyberion.js` is missing, `pnpm kyberion <command>` prints this same sequence instead of a bare `MODULE_NOT_FOUND`.

### Claude Code on the web: automatic

Cloud sessions run `.claude/hooks/session-start.sh` (registered as a `SessionStart` hook in `.claude/settings.json`) before the session starts. It does the sequence above for you: Node 24 via the container's `nvm` (and on `PATH` for the session through `CLAUDE_ENV_FILE`), `pnpm install`, and `pnpm build` only when `dist/` was not built from the current `HEAD` (stamp: `dist/.session-build-head`). A fresh container takes about 6 minutes once; later starts on the same commit take seconds. The hook exits immediately outside cloud sessions (`CLAUDE_CODE_REMOTE` unset).

Node selection order: a Node `>=24` already on `PATH` → the container's `nvm` (`$NVM_DIR`, default `/opt/nvm`; `nvm install 24`) → any `/opt/node*/bin/node` `>=24`. If none of these works, the hook **continues with whatever Node is on `PATH`** and prints a `WARNING` (expect engine warnings) instead of stopping — a Node 22 build is better than no `dist/` at all.

### Recovering when `dist/` is missing (hook deadlock)

Every Claude `PreToolUse` event goes through `scripts/provider_hook_entry.mjs`, which loads the built policy runtime from `dist/scripts/claude_code_hook.js`. When that file is missing the hook stays **fail-closed**: Edit/Write and shell calls are denied with `Kyberion hook runtime unavailable …`. So that the agent can still repair the build itself, the shell event (`PreToolUseShellDeny`) lets through a minimal, exact-shape bootstrap allowlist — one command per Bash call:

| Allowed while the runtime is missing                                      | Notes                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm install` (optionally `--frozen-lockfile` and/or `--prefer-offline`) | no package names, no other flags                                               |
| `pnpm build`, `pnpm --filter @agent/core build`                           | no extra arguments                                                             |
| `bash .claude/hooks/session-start.sh`                                     | re-runs the cloud bootstrap (a no-op outside cloud sessions)                   |
| `git status`, `git log`, `git fetch`                                      | only short read-only flags (`--short`, `--oneline`, `-5`, `--prune`, …)        |
| `git switch <branch>`, `git switch -c <new> [<start>]`, `git checkout -b` | branch moves only; bare `git checkout <x>` stays denied (it can restore paths) |

Any shell metacharacter (`;`, `&&`, `||`, `|`, `` ` ``, `$(`, `>`, `<`, quotes, newlines) disqualifies a command, so the allowlist cannot be chained into anything else. An allowlisted command gets **no** decision from the hook — the normal permission flow still applies. Edit/Write stay denied until `pnpm build` restores `dist/`. Codex and Gemini are unaffected: their fallback never denies shell commands (Codex has no fallback deny; Gemini's `BeforeTool` hook only matches `write_file|replace`).

Recovery sequence from inside the agent, as separate Bash calls: `pnpm install --prefer-offline`, then `pnpm build` (or `bash .claude/hooks/session-start.sh` in a cloud session). The deny reason names these commands.

### Diagnosing session-start failures

- The hook never exits silently: on any failure it prints `[session-start] FAILED (exit N) at .claude/hooks/session-start.sh:<line>: <command>`, the last 20 log lines, and the next step on stderr.
- Full output of `nvm`, `pnpm install` and `pnpm build` is written to `active/shared/tmp/system/session-start/session-start.log` (storage-layout scratch floor, `system` partition; overwritten on every run, swept by the 1-day scratch janitor).
- `nvm.sh` is sourced with `--no-use` and with strict mode (`set -eu`) and the `ERR` trap off: under `set -e` its automatic `nvm use` returns exit 3 when no default version is installed, which used to kill the hook with exit 3 and no output.
- To re-run it by hand: `bash .claude/hooks/session-start.sh` (needs `CLAUDE_CODE_REMOTE=true`, set in cloud sessions).

## Linux secrets

Linux has no OS keychain path in `secret-actuator`. Capabilities show **red** (`[Missing env: KYBERION_ALLOW_FILE_SECRETS]`) until the opt-in file vault is enabled:

```bash
export KYBERION_ALLOW_FILE_SECRETS=1
```

That writes `vault/secrets/file-secrets.json` at `chmod 0600` (directory `0700`). It is **never** the silent default on darwin/win32 keychain. See `libs/core/secret/secret-bridge.ts` (`FileSecretProvider`).

## Related

- First-win install: [`docs/INITIALIZATION.md`](../INITIALIZATION.md) (keep the contract-locked `pnpm kyberion doctor` block unchanged)
- Discovery: [`CAPABILITIES_GUIDE.md`](../../CAPABILITIES_GUIDE.md)
- Gap report: [`ACTUATOR_DAILY_WORK_GAP_REPORT.ja.md`](./ACTUATOR_DAILY_WORK_GAP_REPORT.ja.md)

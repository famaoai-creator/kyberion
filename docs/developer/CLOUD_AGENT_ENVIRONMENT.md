---
title: Cloud Agent environment notes
tags: [cloud-agent, node, build, operator, environment]
last_updated: 2026-09-06
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
pnpm kyberion:doctor
```

If `dist/scripts/kyberion.js` is missing, `pnpm kyberion <command>` prints this same sequence instead of a bare `MODULE_NOT_FOUND`.

## Linux secrets

Linux has no OS keychain path in `secret-actuator`. Capabilities show **red** (`[Missing env: KYBERION_ALLOW_FILE_SECRETS]`) until the opt-in file vault is enabled:

```bash
export KYBERION_ALLOW_FILE_SECRETS=1
```

That writes `vault/secrets/file-secrets.json` at `chmod 0600` (directory `0700`). It is **never** the silent default on darwin/win32 keychain. See `libs/core/secret-bridge.ts` (`FileSecretProvider`).

## Related

- First-win install: [`docs/INITIALIZATION.md`](../INITIALIZATION.md) (keep the contract-locked `pnpm doctor` block unchanged)
- Discovery: [`CAPABILITIES_GUIDE.md`](../../CAPABILITIES_GUIDE.md)
- Gap report: [`ACTUATOR_DAILY_WORK_GAP_REPORT.ja.md`](./ACTUATOR_DAILY_WORK_GAP_REPORT.ja.md)

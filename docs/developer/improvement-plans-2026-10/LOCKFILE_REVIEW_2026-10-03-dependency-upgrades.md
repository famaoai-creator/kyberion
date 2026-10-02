---
title: pnpm lockfile review evidence 2026-10-03 dependency upgrades and mammoth removal
tags: [release-governance, lockfile, security, 2026-10]
last_updated: 2026-10-03
status: active
---

# pnpm lockfile review evidence (2026-10-03 dependency upgrades and mammoth removal)

This file is the explicit review evidence required by `check:lockfile-commit-gate` for the current worktree.

- **Reason for update**:
  - Safely upgrade outdated dependencies across the workspace within compatible ranges.
  - Remove obsolete/legacy `mammoth` package and its patches, unifying document parsing to the repository's native `@agent/core/media/document-reader` engine.
  - Upgrade `fast-check` to latest 4.10.2 and update `.npmrc` / `pnpm-workspace.yaml` configuration for `minimumReleaseAge`.
- **Upgraded packages**:
  - Claude / AI tooling:
    - `@agentclientprotocol/sdk`: `1.4.0` → `1.6.0`
    - `@anthropic-ai/claude-agent-sdk`: `0.3.220` → `0.3.286`
    - `@anthropic-ai/claude-code`: `2.1.220` → `2.1.286`
    - `@modelcontextprotocol/sdk`: `1.30.0` → `1.31.0`
  - Testing & Dev tooling:
    - `@playwright/test`: `1.62.0` → `1.63.0`
    - `playwright`: `1.62.0` → `1.63.0`
    - `puppeteer`: `25.10.0` → `25.12.0`
    - `vitest` / `@vitest/coverage-v8`: `5.0.0`/`5.0.1` → `5.0.3`
    - `vite`: `8.2.2` → `8.3.2`
    - `eslint`: `10.10.0` → `10.11.0`
    - `typescript-eslint`: `8.70.0` → `8.71.0`
    - `@next/eslint-plugin-next` / `eslint-config-next`: `16.3.4` → `16.3.8`
    - `prettier`: `3.9.6` → `3.9.9`
    - `tsx`: `4.23.13` → `4.23.15`
    - `lint-staged`: `17.5.0` → `17.6.0`
    - `globals`: `17.12.0` → `17.13.0`
    - `hyperframes`: `0.8.33` → `0.8.105`
    - `fast-check`: `4.9.0` → `4.10.2`
  - Runtime libraries & utilities:
    - `chalk`: `6.0.0` → `6.0.1`
    - `ws`: `8.21.3` → `8.22.0`
    - `express-rate-limit`: `8.2.2` → `8.7.0`
    - `googleapis`: `178.1.1` → `182.0.0`
    - `marked`: `18.0.12` → `18.0.14`
    - `yargs`: `18.1.0` → `18.2.0`
    - `zod`: `4.5.4` → `4.6.5`
    - `@slack/web-api`: `8.1.1` → `8.2.0`
    - `@types/node`: `26.5.0` → `26.6.3`
    - `@types/ws`: `8.18.1` → `8.18.2`
- **Removed packages**:
- pnpm-lock.yaml sha256: c3a51ba63da4d5575f9cbd8aed25031ebefcfdeec38ef2095ff5fc9021b34161
- The accepted invocation is `PI_ALLOW_LOCKFILE_CHANGE=1 PI_LOCKFILE_REVIEW_EVIDENCE=docs/developer/improvement-plans-2026-10/LOCKFILE_REVIEW_2026-10-03-dependency-upgrades.md pnpm check -- --scope pr`.

---
title: LOCKFILE CHANGE NEXT 2026 10 01.md
tags: [improvement-plan, 2026-09]
last_updated: 2026-09-01
status: active
---

# Lockfile change review — next security update

- **Date**: 2026-10-01
- **Change**: `next` `^16.3.4` → `^16.3.6` in `presence/displays/chronos-mirror-v2`, `presence/displays/concierge` and `presence/displays/operator-surface`; lockfile re-resolved `next` 16.3.4 → 16.3.7.
- **Purpose**: `pnpm audit --audit-level=critical` (the blocking `security` CI job) started failing on a newly published critical advisory, [GHSA-vcvr-r3jv-pc5j](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j) (`next` vulnerable `>=16.2.0 <16.3.6`, patched `>=16.3.6`). Raising the declared minimum to the patched release makes the vulnerable range unrepresentable, instead of relying on the lockfile alone.
- **Before**: 1 critical finding (`next` ×3 workspace paths).
- **After**: `pnpm audit --audit-level=critical` passes; `pnpm audit --audit-level=moderate` passes (1 low finding remains, unrelated to `next`).
- **Lockfile diff reviewed**: entries limited to `next`, `@next/env` and the `@next/swc-*` platform binaries (16.3.4 → 16.3.7), and the removal of a now-unused `baseline-browser-mapping` entry. No other package changed.
- **Compatibility**: patch-level change within the same minor; the three Next apps were rebuilt and their test suites run (see the PR).
- **Lockfile digest**: `pnpm-lock.yaml` sha256: cc19f38f22b5d36316b02327c3429707d01ca03e61c7a8228a6bd6dfd936feac
- **Accepted invocation**: `PI_ALLOW_LOCKFILE_CHANGE=1 PI_LOCKFILE_REVIEW_EVIDENCE=docs/developer/improvement-plans-2026-09/LOCKFILE_CHANGE_NEXT_2026-10-01.md pnpm check -- --scope pr`.

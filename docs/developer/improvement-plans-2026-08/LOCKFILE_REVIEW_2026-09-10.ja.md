---
title: pnpm lockfile review evidence 2026-09-10
tags: [release-governance, lockfile, security, 2026-09]
last_updated: 2026-09-10
status: active
---

# pnpm lockfile review evidence (2026-09-10)

This file is the explicit review evidence required by `check:lockfile-commit-gate` for the current worktree.

- **Reason for update**: Resolve critical security advisories GHSA-p293-qw3h-jr36 (Next.js Unauthenticated Remote Code Execution on windows-hosted servers) and GHSA-2xp9-vwfh-vxw4 (Next.js Unauthenticated Remote Code Execution in Image Optimization API when AVIF files are used).
- **Packages updated**:
  - `next`: `^16.2.12` -> `^16.3.3` in `presence/displays/chronos-mirror-v2/package.json`, `presence/displays/concierge/package.json`, and `presence/displays/operator-surface/package.json`.
  - `@next/eslint-plugin-next`: `^16.2.12` -> `^16.3.3` in root `package.json`.
  - `eslint-config-next`: `^16.2.12` -> `^16.3.3` in root `package.json`.
- **Build configuration**: Webpack build flag (`--webpack`) added to concierge and operator-surface build scripts to prevent Turbopack symlink boundary panic in isolated pnpm monorepo layouts.
- **Audit status**: `pnpm audit --audit-level=critical --ignore-registry-errors` passes cleanly (0 critical vulnerabilities).
- `pnpm-lock.yaml` sha256: 3fe6df62033b3037b69b296f61ce958ad13a36598ca30df142555d34e45fb410
- The accepted invocation is `PI_ALLOW_LOCKFILE_CHANGE=1 PI_LOCKFILE_REVIEW_EVIDENCE=docs/developer/improvement-plans-2026-08/LOCKFILE_REVIEW_2026-09-10.ja.md pnpm check -- --scope pr`.

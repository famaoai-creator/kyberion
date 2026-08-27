---
title: pnpm lockfile review evidence 2026-08-27
tags: [release-governance, lockfile, 2026-08]
last_updated: 2026-08-27
status: active
---

# pnpm lockfile review evidence (2026-08-27)

This file is the explicit review evidence required by `check:lockfile-commit-gate` for the current worktree.

- The lockfile adds the exact-pinned `eslint-plugin-import@2.32.0` and `eslint-import-resolver-typescript@3.10.1` development dependencies needed by the repository-wide `import/no-cycle` check.
- The five `semver` consumers were reviewed together, and their integration is normalized to `semver@7.8.5`.
- The remaining large diff is pnpm serialization/normalization churn; workspace package versions and `patchedDependencies` were reviewed separately, and no patch entry was changed.
- `pnpm-lock.yaml` sha256: 59992519e4878ed3e7d4ef4c9cf43289f093e6efd4a92e5b9d1b346e5735475b
- The accepted invocation is `PI_ALLOW_LOCKFILE_CHANGE=1 PI_LOCKFILE_REVIEW_EVIDENCE=docs/developer/improvement-plans-2026-08/LOCKFILE_REVIEW_2026-08-27.ja.md pnpm check -- --scope pr`.

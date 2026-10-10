---
title: pnpm lockfile review evidence 2026-10-10 GitHub security alerts
tags: [release-governance, lockfile, security, 2026-10]
last_updated: 2026-10-10
status: active
---

# pnpm lockfile review evidence (2026-10-10 GitHub security alerts)

This file is the explicit review evidence required by `check:lockfile-commit-gate` for the current worktree.

- **Reason for update**: close the four open Dependabot alerts tracked against `pnpm-lock.yaml` (`@graphql-tools/utils` prototype pollution, `katex` prototype-pollution trust bypass, `postcss-selector-parser` quadratic parsing, `esbuild` dev-server file read) with `pnpm-workspace.yaml` overrides, matching the repository's established override pattern.
- **Overrides added** (`pnpm-workspace.yaml`):
  - `graphql-yoga@<5.24.4 → ^5.24.4` and `@graphql-yoga/plugin-defer-stream@<3.24.4 → ^3.24.4`: the new patch releases depend on `@graphql-tools/utils@^12.0.3`, removing the vulnerable `11.2.2` resolution entirely.
  - `katex@<0.18.2 → ^0.19.0`: all `0.18.x` releases are deprecated upstream ("Accidentally published with breaking changes"), so the override targets the supported `0.19.0` line rather than the flagged `0.16.47`.
  - `postcss-selector-parser@<7.1.6 → ^7.1.6`: fixes the flat-selector CPU exhaustion issue for `tailwindcss@3.4.x` / `postcss-nested@6.2.0` consumers (build-time only).
  - `esbuild: ^0.27.0 → ^0.28.1` (existing blanket override retargeted): it was rewriting every request — including the root's `^0.28.2` — back down to the vulnerable `0.27.7`; all `esbuild` resolutions are now unified at `0.28.2`.
- **Deleted**: `package-lock.json` (stale npm lockfile, last touched 2026-03; the repository is pnpm-managed — `managed_env_setup.ts` passes `--no-package-lock` — and 166 open Dependabot alerts were tracked against this unused manifest).
- **Diff review**: the lockfile delta is limited to the resolutions above plus the `commander@8.3.0 → 15.0.0` swap pulled in by `katex@0.19.0` and the `esbuild` `@esbuild/*` platform-binary rows for `0.27.7 → 0.28.2`. No other package version, `patchedDependencies`, or workspace specifier changed.
- `pnpm-lock.yaml` sha256: 34582d040922c24ba04763e68f700fcc8a7fccbb0293301d8df9a87c7511545d
- The accepted invocation is `PI_ALLOW_LOCKFILE_CHANGE=1 PI_LOCKFILE_REVIEW_EVIDENCE=docs/developer/improvement-plans-2026-10/LOCKFILE_REVIEW_2026-10-10-github-security-alerts.md pnpm check -- --scope pr`.

---
title: pnpm lockfile review evidence 2026-09-10 dependency major updates
tags: [release-governance, lockfile, security, 2026-09]
last_updated: 2026-09-10
status: active
---

# pnpm lockfile review evidence (2026-09-10 dependency major updates)

This file is the explicit review evidence required by `check:lockfile-commit-gate` for the current worktree.

- **Base**: stacked on `chore/dependency-safe-updates-20260910` (#723).
- **Reason for update**: Trial major/breaking dependency upgrades that were deferred from the safe-update PR.
- **Applied majors / large jumps**:
  - `vitest` / `@vitest/coverage-v8`: 4 → **5** (migrate `describe.sequential` → `describe(..., { concurrent: false })`)
  - `eslint-import-resolver-typescript`: 3 → **4**
  - `json-schema-to-typescript`: 15 → **16**
  - `@agentclientprotocol/sdk`: 1.3 → **1.4**
  - `googleapis`: 173 → **178**
  - `@openai/codex`: 0.146 → **0.153**
  - `hyperframes`: 0.7 → **0.8**
  - `openai` (`@agent/core`): 6 → **7**
  - `pdfjs-dist`: 4 → **6**
  - `ink`: 6 → **7**
  - `uuid` (slack-bridge): 9 → **14** (drop deprecated `@types/uuid`)
  - CopilotKit packages: 1.64 → **1.70**
  - `lucide-react`: 0.446 → **1.43**
  - `tailwind-merge`: 2 → **3**
- **Tried and reverted**:
  - TypeScript **7.0.2** — breaks `typescript` compiler-API imports used by i18n/type-ratchet/refactor scripts (package entry resolves to a stub `version` module). Stay on 5.9.x until API surface stabilizes for our tooling.
- **Still deferred**:
  - `tailwindcss` 4 (requires PostCSS/plugin migration)
- **Audit status**: `pnpm audit --audit-level=critical --ignore-registry-errors` expected clean on this tree.
- pnpm-lock.yaml sha256: d88071d7c848f9eef4e68fa5c6a56c80931163c89853364232001b99b3775188
- The accepted invocation is `PI_ALLOW_LOCKFILE_CHANGE=1 PI_LOCKFILE_REVIEW_EVIDENCE=docs/developer/improvement-plans-2026-08/LOCKFILE_REVIEW_2026-09-10-dependency-major-updates.ja.md pnpm check -- --scope pr`.

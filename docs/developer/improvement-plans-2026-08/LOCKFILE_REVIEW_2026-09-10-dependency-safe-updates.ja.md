---
title: pnpm lockfile review evidence 2026-09-10 dependency safe updates
tags: [release-governance, lockfile, security, 2026-09]
last_updated: 2026-09-10
status: active
---

# pnpm lockfile review evidence (2026-09-10 dependency safe updates)

This file is the explicit review evidence required by `check:lockfile-commit-gate` for the current worktree.

- **Reason for update**: Apply security-relevant and same-major safe dependency bumps without crossing intentionally deferred major upgrades (TypeScript 7, Vitest 5, OpenAI 7, Tailwind 4, Ink 7, CopilotKit 1.70, Google APIs major, Hyperframes 0.8).
- **Security-focused packages**:
  - `@xmldom/xmldom`: `0.9.10` → `0.9.12` (workspace override + direct dependency; clears GHSA-965w-775f-mr7g / GHSA-93r5-fhx6-vmg9)
  - `mammoth`: `^1.12.0` → `^1.12.2` and retarget Kyberion patch to `patches/mammoth@1.12.2.patch`
  - `jszip`: `^3.10.1` → `^3.10.2`
  - `js-yaml`: `^5.2.2` → `^5.4.1`
  - `axios`: `^1.18.1` → `^1.20.0`
  - `next` / `eslint-config-next` / `@next/eslint-plugin-next`: `^16.3.3` → `^16.3.4`
- **Additional same-major safe bumps**:
  - Runtime: `marked`, `ws`, `zod`, `@slack/bolt`, `@slack/web-api`, `papaparse`, `puppeteer`, `discord.js`
  - Tooling: `eslint`, `@eslint/eslintrc`, `globals`, `typescript-eslint`, `vite`, `tsx`, `lint-staged`, `@types/node`, presence React type packages / `postcss`
- **Intentionally deferred majors / large jumps**: TypeScript 7, Vitest 5, `eslint-import-resolver-typescript` 4, Google APIs 178, Hyperframes 0.8, CopilotKit 1.70, Ink 7, OpenAI SDK 7, PDF.js 6, UUID 14.
- **Audit status**: `pnpm audit --audit-level=critical --ignore-registry-errors` passes (0 critical). High findings reduced from 39 → 22 after this update.
- pnpm-lock.yaml sha256: 76b954e690b0b22e59511d60eaafd2e93758bd0220d46be42de7b7a5eb9627df
- The accepted invocation is `PI_ALLOW_LOCKFILE_CHANGE=1 PI_LOCKFILE_REVIEW_EVIDENCE=docs/developer/improvement-plans-2026-08/LOCKFILE_REVIEW_2026-09-10-dependency-safe-updates.ja.md pnpm check -- --scope pr`.

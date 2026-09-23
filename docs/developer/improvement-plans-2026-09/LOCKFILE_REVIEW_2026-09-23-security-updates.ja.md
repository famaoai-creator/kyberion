---
title: Security dependency update review 2026-09-23
tags: [release-governance, lockfile, security, 2026-09]
last_updated: 2026-09-23
status: active
---

# Security dependency update review (2026-09-23)

This record covers the workspace dependency security update requested on 2026-09-23.

- **Before**: workspace audit reported 77 findings (21 high, 44 moderate, 12 low; 0 critical).
- **After**: pnpm audit reported 0 findings at every severity across 1,827 dependency entries.
- **Method**: pnpm audit --fix=update refreshed resolvable lockfile entries. pnpm audit --fix=override added version-range overrides for remaining vulnerable transitive dependencies. Updated the existing security pins for @hono/node-server (1.19.13 → 1.19.17), fast-uri (3.1.2 → 3.1.8), and undici (6.27.0 → 6.28.1), which had prevented those fixes from taking effect.
- **Other patched resolution families**: brace-expansion, dompurify, ip-address, uuid, qs, mermaid, esbuild, protobufjs, body-parser, hono, image-size, nanoid, postcss-selector-parser, browserslist, @humanfs/node, phoenix, @ai-sdk/provider-utils, vitest / @vitest/mocker, and baseline-browser-mapping.
- **Major transitive updates**: image-size moved from 1.x to 2.0.4 and vulnerable transitive uuid 8.x resolutions moved to 11.1.1. The lockfile audit is clean; application tests were not run in this update.
- pnpm-lock.yaml sha256: 5af9e0848a5ddf07bc4e861d40189b375822b0b19cbecd2f99604669d3c35f23
- The accepted invocation is PI_ALLOW_LOCKFILE_CHANGE=1 PI_LOCKFILE_REVIEW_EVIDENCE=docs/developer/improvement-plans-2026-09/LOCKFILE_REVIEW_2026-09-23-security-updates.ja.md pnpm check -- --scope pr.

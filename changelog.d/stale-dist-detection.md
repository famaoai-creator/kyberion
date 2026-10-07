---
category: Added
---

- **Baseline check detects stale build output** — `baseline-check` layer L2 now flags `needs_recovery` when a `dist/` tree is older than its sources (tsbuildinfo content-hash compare, mtime fallback), covering root, actuator, package, and root-emitted `dist/libs/<pkg>` builds. Rebuild with `pnpm run build` when it fires. New standalone scan: `node dist/scripts/check_stale_dist.js`. A `needs_recovery` exit is also no longer re-printed as a second `fatal_error` JSON blob.
- **Mission task completion cascades** — `record-evidence` / `review-task` now auto-complete dependent tasks whose deliverables already exist; a review closing late no longer leaves `delivery-*`/`retrospective-*` stuck `planned` at `finish`.
- **`mission.validating` status renders localized text** — the `[UX_VOCAB]` fallback warning on `pnpm mission list` is gone in all locales.
- **Actuator builds write their own `dist/.tsbuildinfo.actuators`** — the previously shared `dist/.tsbuildinfo` could mask stale actuator output.
- **Stale-build troubleshooting runbook** — new `knowledge/product/orchestration/stale-build-troubleshooting-runbook.md` covering symptoms → root cause → rebuild ladder → edge cases.

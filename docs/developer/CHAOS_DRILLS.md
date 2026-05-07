---
title: Chaos Drills
category: Developer
tags: [chaos, drill, reliability, b-5]
importance: 7
last_updated: 2026-05-07
---

# Chaos Drills

Recurring failure-injection runs that exercise Kyberion's error handling under realistic adverse conditions. The goal is **not** to break things — it's to verify that breakage is **detected, classified, and gracefully handled** before it happens in a real customer environment.

This is Phase B-5 of `docs/PRODUCTIZATION_ROADMAP.md`.

## Current drills

| Pipeline | What it injects | Expected handling |
|---|---|---|
| `pipelines/chaos-actuator-down.json` | Actuator binary unavailable (mask PATH) | Either `on_error.fallback` runs, or pipeline aborts with category `missing_dependency`. No unhandled exception. |
| `pipelines/chaos-network-partition.json` | Unreachable host / DNS failure | Error classifier returns `network` or `timeout`. Pipeline status = `failed`. |
| `pipelines/chaos-secret-missing.json` | secret:read of nonexistent key | Error classifier returns `missing_secret` or `auth`. **No secret-shaped value in logs.** |

## Manual run

```bash
pnpm pipeline --input pipelines/chaos-actuator-down.json
pnpm pipeline --input pipelines/chaos-network-partition.json
pnpm pipeline --input pipelines/chaos-secret-missing.json
```

Each drill prints `CHAOS_OK: ...` when the failure was handled as expected. If any drill does not print that and instead crashes / hangs / leaks data, file an issue with label `chaos-failure`.

## Scheduled run

Weekly via the existing scheduler. To register, add to your environment's cron / `pnpm schedule`:

```
0 4 * * 0   pnpm pipeline --input pipelines/chaos-actuator-down.json     >> active/shared/logs/chaos.log 2>&1
15 4 * * 0  pnpm pipeline --input pipelines/chaos-network-partition.json >> active/shared/logs/chaos.log 2>&1
30 4 * * 0  pnpm pipeline --input pipelines/chaos-secret-missing.json    >> active/shared/logs/chaos.log 2>&1
```

The maintainer-run reference deployment runs these on Sunday 04:00 UTC.

## Adding a drill

1. Create `pipelines/chaos-<failure-mode>.json` with `labels: ["chaos", "drill", ...]`.
2. The pipeline's `expected_outcome` field is human-readable, used in PR review.
3. Use `on_error.fallback` to record `CHAOS_OK: ...` so the drill is self-verifying.
4. Add an entry to the table above.

## What's NOT in scope

- Long-running soak tests (Phase B-3 / B-5 follow-up).
- Multi-actuator deadlock scenarios (deferred — needs a coordinator).
- Production-data corruption simulation (we never run this against real customer data).
- Process-crash mid-checkpoint (Phase B-3 deferred work).

## Related

- [`docs/developer/MISSION_LIFECYCLE_AUDIT.md`](./MISSION_LIFECYCLE_AUDIT.md) — Phase B-3 mission lifecycle gaps.
- [`libs/core/error-classifier.ts`](../../libs/core/error-classifier.ts) — what the drills verify the classifier on.

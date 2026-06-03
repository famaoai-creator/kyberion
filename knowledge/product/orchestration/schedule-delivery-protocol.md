---
title: Schedule Delivery Protocol
category: Orchestration
tags: [orchestration, schedule, delivery, workdir]
importance: 7
author: Ecosystem Architect
last_updated: 2026-05-03
---

# Schedule Delivery Protocol

Kyberion recurring schedules need a stable delivery model so generated
artifacts land in a predictable place.

## 1. Directory Roles

- `artifact_dir`
  - primary workdir for generated schedule output
  - preferred location for schedule-local artifacts
- `latest_alias_path`
  - stable alias that points to the most recent successful artifact
  - used for operator-facing "latest" access

## 2. Resolution Order

When a schedule is reconciled:

1. prefer `delivery_policy.artifact_dir`
2. otherwise use the parent directory of `delivery_policy.latest_alias_path`
3. otherwise fall back to the schedule file directory

This keeps schedule execution deterministic even when the schedule was
registered from different working directories.

## 3. Copy Rule

When a job succeeds and the schedule defines a latest alias:

- copy the generated artifact to the resolved alias path
- leave the original artifact in place
- keep the alias path stable across ticks

## 4. Kyberion Meaning

This is the scheduling equivalent of Hermes-style workdir/delivery
normalization:

- the schedule owns the output contract
- the runner resolves paths consistently
- delivery surfaces can always find the latest artifact


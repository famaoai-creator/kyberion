---
record_id: mem-MSN-HERMES-RUNTIME-20261028-2026_10_27
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-HERMES-RUNTIME-20261028-2026_10_27
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-27T19:20:09.469Z
source_branch: feat/hermes-adoption-20261028
source_commit: 6e9c2a827dfb68f673d27db62cec69cb7dcdb32e
---

# Supervise continuous execution with admission, semantic progress and cancellation

Continuous mode may remove implicit global ceilings only when each step remains admitted and meaningful progress is observable; explicit budgets, limits and cancellation still win.

## Applicability

- mission
- mission:MSN-HERMES-RUNTIME-20261028

## Reusable Steps

1. Continuous mode may remove implicit global ceilings only when each step remains admitted and meaningful progress is observable; explicit budgets, limits and cancellation still win

## Expected Outcome

Separate the lifetime of a continuous goal from the finite deadlines of individual model, tool and compaction operations. Remove an implicit turn ceiling only when the real caller supplies per-step admission. Continuous delegation requires a harness that reports semantic progress; process liveness and increasing stdout do not renew an inactivity window. Unsupported providers remain bounded and must refuse an explicit unsupported continuous request. Preserve explicit max-turn, budget and deadline settings; late results after cancellation or terminal state must not revive success. Detect repeated operations using both arguments and results so legitimate progress and polling are not treated as a stall. Fence compaction by generation and preserve raw scoped history before incomplete recovery; do not replay uncertain external effects. Bound child-result presentation using the parent's latest prompt occupancy, not cumulative session tokens, while preserving full scoped artifacts and valid structured results. Classify model-specific rate limits separately from provider-wide authentication failure so one model's cooldown does not disable healthy siblings. Fake-provider and virtual-time regressions do not establish paid-provider or long-duration production performance.

## Evidence

- active/missions/public/MSN-HERMES-RUNTIME-20261028/evidence/continuous-execution-amendment.json
- active/missions/public/MSN-HERMES-RUNTIME-20261028/evidence/implementation-report.md
- active/missions/public/MSN-HERMES-RUNTIME-20261028/evidence/test-report.md

## Artifacts

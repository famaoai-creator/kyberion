---
record_id: mem-MSN-DOT-ADMISSION-20261011-2026_10_11
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-DOT-ADMISSION-20261011-2026_10_11
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-11T13:21:58.428Z
source_branch: fix/dot-admission-reporting-20261011
source_commit: edfcb427f5e9f6ef27977309f320ed03c23d2131
---

# Durable dot admission and evidence-based reporting

Persist scoped operation admission before executable work; reconcile immutable identity and report only outcomes supported by execution or delivery receipts.

## Applicability

- mission
- mission:MSN-DOT-ADMISSION-20261011

## Reusable Steps

1. Persist scoped operation admission before executable work; reconcile immutable identity and report only outcomes supported by execution or delivery receipts

## Expected Outcome

Bind every generic action to its dot and tenant scope, stable originating wake key and original proposal ordinal before creating an executable WorkItem. Use deterministic create-if-absent identity and validate the original creation snapshot, including legacy random-ID and archived items. Recovery repairs admission and records; it never reopens work or retries uncertain effects. Recheck current approval, charter and mandatory gates before creating missing work. Preserve suppression for pending/rejected proposals and unresolved work across new wake keys; permit repeated identical work only with matching successful terminal evidence.

A dispatched item is queued, not completed. Match work-result receipts to action, item, current attempt and operator-release ordering before saying done. Keep frozen digest text physically tenant-scoped, preserve its content cutoff while delivery is delayed, and bound retries and catchup. Persist notification intent before delivery and reconcile stable outbox/inbox acceptance evidence after interruptions. Acceptance is not proof of user delivery. Suppression and uncertain external effects must settle without blind replay; retain deduplication tombstones until their callers can no longer retry.

Enforce these rules with crash-before/after-create, concurrent-process, legacy migration, changed semantics, tenant, approval revocation, stale attempt, missed schedule, mute, and enqueue-before-receipt tests.

Repository checks: libs/core/dot/dot-admission-recovery.test.ts, libs/core/dot/dot-digest-recovery.test.ts, and libs/core/surface/operator-notifications.test.ts. Operational guidance: knowledge/product/governance/operations-hygiene-runbook.md.

## Evidence

- active/missions/public/MSN-DOT-ADMISSION-20261011/evidence/implementation-report.md
- active/missions/public/MSN-DOT-ADMISSION-20261011/evidence/test-report.md

## Artifacts

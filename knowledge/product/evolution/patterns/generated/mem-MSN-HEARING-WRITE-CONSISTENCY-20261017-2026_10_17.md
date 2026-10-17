---
record_id: mem-MSN-HEARING-WRITE-CONSISTENCY-20261017-2026_10_17
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-HEARING-WRITE-CONSISTENCY-20261017-2026_10_17
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-17T14:38:43.966Z
source_branch: qa/hearing-consistency-published
source_commit: 3c5376a9cbec2eee8a774584c1a810c9f968050a
---

# Hearing updates require shared atomic mutation and fail-closed completion reservations

Atomic file rename does not prevent stale asynchronous snapshots from overwriting hearing answers or decisions. Serialize all writers and separately guard external completion effects.

## Applicability

- mission
- mission:MSN-HEARING-WRITE-CONSISTENCY-20261017

## Reusable Steps

1. Atomic file rename does not prevent stale asynchronous snapshots from overwriting hearing answers or decisions
2. Serialize all writers and separately guard external completion effects

## Expected Outcome

When multiple HTTP requests or processes update a hearing record, require one short synchronous read/modify/write lock shared by every writer. Atomic rename alone is not compare-and-swap. Maintain a record revision for persistence and a requirements revision for decision validity. Apply asynchronous results only after reloading and checking their relevant snapshot; preserve newer decision metadata when rendering an unchanged requirement set. A real answer change invalidates the prior decision, while unchanged answers may retain it.

Before mission or inventory effects, revalidate the decided requirements and persist a unique reservation under the same lock. Finalize only the matching reservation and snapshot. If the effect or final record save is uncertain, retain the reservation, return a bounded localized conflict, and block repeat completion; time passage is not evidence that an effect did not happen. Preserve normal completed-ID replay. Test deferred promises, actual independent processes, legacy records, failed reservation writes, and failure after external effects.

This protection requires all writers to share the filesystem, lock and PID namespace and run the compatible version. It lasts only while the session record survives existing temporary retention; it is not durable exactly-once execution. Quiesce writers before rollback and inspect unresolved effects. Durable operation receipts and retention migration need a separate design. Distinguish synthetic UI assertions from real-browser evidence.

## Evidence

- active/missions/public/MSN-HEARING-WRITE-CONSISTENCY-20261017/evidence/design-spec.json
- active/missions/public/MSN-HEARING-WRITE-CONSISTENCY-20261017/evidence/test-report.md
- active/missions/public/MSN-HEARING-WRITE-CONSISTENCY-20261017/evidence/REVIEW-execution-implement.md

## Artifacts

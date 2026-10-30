---
record_id: mem-MSN-BOARD-WRITERS-LEASE-20261030-2026_10_30
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-BOARD-WRITERS-LEASE-20261030-2026_10_30
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-30T04:36:14.592Z
source_branch: fix/board-writers-lease-20261030
source_commit: 96bc24f02d3346dc543371a73dea41d3580e930c
---

# Board updates get their own copy, and side-effect writers stamp after the lease

When moving a NEXT_TASKS.json writer onto writeMissionNextTasks's update form, decide on the board read under the writer lease, keep WorkItem calls outside the lease and stamp their results by task_id afterwards, and never let the update alias the board the supersede guard compares against.

## Hint Scope

mission

## Trigger Phrases

- - The update form only protects a writer when its read, decision and write all happen under the lease. A copy read earlier and written back loses a worker status write made meanwhile.
- Writers with side effects (ticket dispatch's importExternalWorkItem, recovery's claimWorkItem) keep those calls outside the lease, record what they decided per task_id, and apply it to the leased board. Re-check the precondition under the lease too: recovery stamps only a task still 'requested' on the same work_item_id, and logs a claim it could not record.
- Aliasing pitfall: the guard compares incoming against onDisk. If the update gets onDisk itself and edits it in place, both are the same objects and the guard no longer freezes a superseded task. writeMissionNextTasks passes structuredClone(onDisk) to the update for this reason.
- The writer lease is not re-entrant: a nested acquire waits 5 s and fails with LOCK_TIMEOUT. Update functions and the callbacks they run (auto-complete's isHeld/canCascade) must only read.
- Race tests: vi.mock the WorkItem module and complete another task from a hook inside the WorkItem call; the old whole-array write reverts it.
- Still outside the lease: reconcile-work, work-graph projection apply and the orchestrator task plan.

## Recommended References

- active/missions/public/MSN-BOARD-WRITERS-LEASE-20261030/evidence/implementation-report.md
- active/missions/public/MSN-BOARD-WRITERS-LEASE-20261030/evidence/test-report.md
- active/missions/public/MSN-BOARD-WRITERS-LEASE-20261030/evidence/REVIEW-execution-implement.md

## Evidence

- active/missions/public/MSN-BOARD-WRITERS-LEASE-20261030/evidence/implementation-report.md
- active/missions/public/MSN-BOARD-WRITERS-LEASE-20261030/evidence/test-report.md
- active/missions/public/MSN-BOARD-WRITERS-LEASE-20261030/evidence/REVIEW-execution-implement.md

## Artifacts

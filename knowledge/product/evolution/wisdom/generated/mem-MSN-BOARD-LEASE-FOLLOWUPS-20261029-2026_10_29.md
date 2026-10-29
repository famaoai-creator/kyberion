---
record_id: mem-MSN-BOARD-LEASE-FOLLOWUPS-20261029-2026_10_29
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-BOARD-LEASE-FOLLOWUPS-20261029-2026_10_29
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-29T02:47:03.361Z
source_branch: fix/board-lease-followups-20261029
source_commit: e11b70d63df473e56191bbf881346531f804a305
---

# Apply board updates under the writer lease, and register WorkItems only for the writer's own tasks

A NEXT_TASKS writer must apply its change to the board read under the writer lease, not to its earlier copy. When it then registers WorkItems from the guarded result, it must filter to the tasks it brought: importExternalWorkItem overwrites an existing item's status and metadata with no transition check, so re-importing a task the guard kept from disk resets a done or running item to ready.

## Hint Scope

mission

## Trigger Phrases

- - writeMissionNextTasks(missionPath, (onDisk) => next | undefined) reads, guards, validates and writes under one fenced writer lease; build an update from onDisk, not from a plan read earlier, and return undefined for no change. Nothing inside the update function may take the lease or a lock again: a nested acquire waits 5 s, then throws LOCK_TIMEOUT.
- A value computed from the fresh board inside the update (for example reissued ids) must be reset at the top of the function, and a check that needs the mission to exist (resolveMissionDir throws) belongs before the call.
- A writer whose plan was read earlier must re-check each target on the fresh board: a dependent that closed in the meantime keeps its history (m2).
- guardSupersedeState returns more than its input: a superseded task and a replacement the plan omitted are kept from disk. Register WorkItems only for ids in the writer's own input; importExternalWorkItem on an existing item replaces status and metadata without a transition check.
- Every path that blocks a worker task must end the attempt (updateWorkItem({ status: 'blocked', endAttempt: true })), not just the customer-decision hold, or a resume hits a lease conflict until the TTL.
- Prove each concurrency fix with a test that fails on the old code: inject the competing write through a hook that runs between the plan read and the write (ledger beforeAppend), and assert the on-disk board and the WorkItem store, not only the return value.

## Recommended References

- active/missions/public/MSN-BOARD-LEASE-FOLLOWUPS-20261029/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-BOARD-LEASE-FOLLOWUPS-20261029/evidence/implementation-report.md
- active/missions/public/MSN-BOARD-LEASE-FOLLOWUPS-20261029/evidence/test-report.md
- active/missions/public/MSN-BOARD-LEASE-FOLLOWUPS-20261029/evidence/distillation.md

## Evidence

- active/missions/public/MSN-BOARD-LEASE-FOLLOWUPS-20261029/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-BOARD-LEASE-FOLLOWUPS-20261029/evidence/implementation-report.md
- active/missions/public/MSN-BOARD-LEASE-FOLLOWUPS-20261029/evidence/test-report.md
- active/missions/public/MSN-BOARD-LEASE-FOLLOWUPS-20261029/evidence/distillation.md

## Artifacts

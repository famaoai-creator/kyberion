---
record_id: mem-MSN-FOLLOWUPS-HYGIENE-20261029-2026_10_28
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-FOLLOWUPS-HYGIENE-20261029-2026_10_28
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-28T18:17:57.715Z
source_branch: fix/followups-hygiene-20261029
source_commit: 5136d4fd4708c7d681cee6fc4a79647bd8253703
---

# Move only a protection's invariant into a shared writer, and merge both sides' records

When a guard that lived in one writer becomes the shared writer's guard, generalise only the invariant (never undo an approved supersede), not that writer's whole merge policy, and merge on-disk and incoming records because a privileged writer's incoming copy can be newer than disk.

## Hint Scope

mission

## Trigger Phrases

- - NEXT_TASKS.json: guardSupersedeState (mission-next-tasks-supersede-guard.ts) runs in writeMissionNextTasks against the board read right before the write; a superseded task is frozen as on disk, its replacement is kept, dependents' rewrites are merged from both sides and followed to a fixed point (T1->T2->T3), and only supersede-task (allowSupersede) introduces a supersede.
- Do not move the dispatcher's status-priority merge into the shared writer: it would block legitimate status changes (recovery blocked->planned, review reopen).
- A shared writer is also used by the privileged writer: trusting the on-disk record lists drops what the privileged write just added; merge both.
- A block that waits on someone else (customer-decision hold) ends the attempt and releases the WorkItem lease (updateWorkItem endAttempt), or a resume hits lease_conflict until the TTL expires.
- Map every writer of a shared file before moving a guard (read-only explore agent), then have an independent reviewer look for regressions the move itself creates.

## Recommended References

- active/missions/public/MSN-FOLLOWUPS-HYGIENE-20261029/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-FOLLOWUPS-HYGIENE-20261029/evidence/implementation-report.md
- active/missions/public/MSN-FOLLOWUPS-HYGIENE-20261029/evidence/test-report.md
- active/missions/public/MSN-FOLLOWUPS-HYGIENE-20261029/evidence/retrospective.md
- active/missions/public/MSN-FOLLOWUPS-HYGIENE-20261029/evidence/distillation.md
- active/missions/public/MSN-FOLLOWUPS-HYGIENE-20261029/evidence/design-spec.json

## Evidence

- active/missions/public/MSN-FOLLOWUPS-HYGIENE-20261029/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-FOLLOWUPS-HYGIENE-20261029/evidence/implementation-report.md
- active/missions/public/MSN-FOLLOWUPS-HYGIENE-20261029/evidence/test-report.md
- active/missions/public/MSN-FOLLOWUPS-HYGIENE-20261029/evidence/retrospective.md
- active/missions/public/MSN-FOLLOWUPS-HYGIENE-20261029/evidence/distillation.md
- active/missions/public/MSN-FOLLOWUPS-HYGIENE-20261029/evidence/design-spec.json

## Artifacts

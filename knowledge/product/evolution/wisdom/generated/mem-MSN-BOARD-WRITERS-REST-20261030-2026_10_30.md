---
record_id: mem-MSN-BOARD-WRITERS-REST-20261030-2026_10_30
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-BOARD-WRITERS-REST-20261030-2026_10_30
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-30T05:49:07.383Z
source_branch: fix/board-writers-rest-20261030
source_commit: 5910e8246e2f8b71b176b456e06c5ae77d363d9d
---

# A board rebuilt from canonical state must prove the record it carries, not the board's

Writers that rebuild NEXT_TASKS.json from WorkItems (projection apply, reconcile-work) need to carry a superseded task; prove the incoming supersede record against the approved, applied supersede-task, because the board on disk may not hold it yet.

## Hint Scope

mission

## Trigger Phrases

- - The supersede guard drops any incoming 'superseded' status unless the writer is supersede-task. A board rebuilt from WorkItems therefore reopened superseded tasks and then stuck on projection drift. writeMissionNextTasks now takes acceptProvenSupersede.
- Prove the record the writer holds (missionTaskSupersedeRecordProof): approved human mission_gate, effect binding for the task, payload hash of mission/task/by/reason_sha256, human_only decision, and apply evidence (receipt or task_superseded ledger entry). A board-based proof can never pass at the guard's decision point, because the guard asks only when the board entry is not superseded.
- Test with a real approve, supersede, delete-board, rebuild path. A mocked predicate hid this blocker for a whole review round.
- Do not let a writer-side proof consume a gate reader's once-per-process warning; use a quiet check.
- A rebuilt or reconciled board should take only the closing status from WorkItems and keep board-only fields. A WorkItem in review projects as 'reviewed', which is not closed.
- Plans that reference a superseded id should follow the supersede chain to the replacement, and must drop a dependency that resolves to the task itself.

## Recommended References

- active/missions/public/MSN-BOARD-WRITERS-REST-20261030/evidence/implementation-report.md
- active/missions/public/MSN-BOARD-WRITERS-REST-20261030/evidence/test-report.md
- active/missions/public/MSN-BOARD-WRITERS-REST-20261030/evidence/REVIEW-execution-implement.md

## Evidence

- active/missions/public/MSN-BOARD-WRITERS-REST-20261030/evidence/implementation-report.md
- active/missions/public/MSN-BOARD-WRITERS-REST-20261030/evidence/test-report.md
- active/missions/public/MSN-BOARD-WRITERS-REST-20261030/evidence/REVIEW-execution-implement.md

## Artifacts

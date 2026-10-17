---
record_id: mem-MSN-TASK-SESSION-20261017-2026_10_17
kind: sop_candidate
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-TASK-SESSION-20261017-2026_10_17
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-17T13:46:19.506Z
source_branch: feat/task-session-enable-20261017
source_commit: e5566d15d46c0faaa0d5eaf37b5b89fb82dce189
---

# task_session enablement: port flag conditional on backend resolution

taskSessionUnavailable set only when no backend resolves; else task_session runs governed runGoalTurn with budget/turn caps. Shape use needs both charter allowed_work_shapes and a capable port.

## Procedure Steps

1. Enabling a dot work shape is two gates: charter.authority (allowed_work_shapes/allowed_pipelines) and the executor port capability. task_session v1 routes through governed runGoalTurn (advisory turns, no work tools). pipeline_ref must be a repo-relative pipelines/<name>.json path matching allowed_pipelines verbatim.

## Safety Notes

- Require approval before irreversible or high-risk actions.
- Capture evidence before and after the action.

## Escalation Conditions

- Unexpected runtime failure
- Policy or approval mismatch
- Result does not match the expected state

## Evidence

- active/missions/public/MSN-TASK-SESSION-20261017/evidence/distillation.md
- active/missions/public/MSN-TASK-SESSION-20261017/evidence/ledger.jsonl

## Artifacts

---
record_id: mem-MSN-DOGFOOD-FLOW-20261006-2026_10_05
kind: sop_candidate
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-DOGFOOD-FLOW-20261006-2026_10_05
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-05T18:28:44.938Z
source_branch: main
source_commit: 2ad27fa6bd4f7b26b54778ef3f0418a061cc5f65
---

# organization operation add validates execution-ref only for runbook kind

pnpm organization operation add accepts execution kinds task_session/mission/pipeline without a ref, but organization reconcile then flags invalid_execution_refs and org status degrades to attention. Provide --execution-ref (or use runbook/actuator kinds) at add-time; consider extending add-time validation to all non-actuator kinds.

## Procedure Steps

1. During MSN-DOGFOOD-FLOW-20261006, registering an event_driven operation with --execution-kind task_session and no --execution-ref succeeded, then `pnpm organization reconcile` reported invalid_execution_refs and status showed Reconciliation: attention. Re-registering as runbook + knowledge/product/orchestration/mission-kickoff-playbook.md cleared it. Org writes require KYBERION_PERSONA=sovereign (or MISSION_ROLE=organization_operator + KYBERION_TENANT). operation run record --execution-ref must be a scoped existing path (e.g. active/missions/.../mission-state.json); the mission:<id> shorthand is rejected.

## Safety Notes

- Require approval before irreversible or high-risk actions.
- Capture evidence before and after the action.

## Escalation Conditions

- Unexpected runtime failure
- Policy or approval mismatch
- Result does not match the expected state

## Evidence

- active/missions/public/MSN-DOGFOOD-FLOW-20261006/evidence/ops-report.md
- active/missions/public/MSN-DOGFOOD-FLOW-20261006/evidence/operation-run-receipt.md

## Artifacts

---
record_id: MEM-MUCXM7LX-EEAA86B9-R1
kind: sop_candidate
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: MEM-MUCXM7LX-EEAA86B9-R1
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-05T13:31:38.600Z
source_branch: fix/voice-media-session-id-20261005
source_commit: 3914948b3e61c1a44cc2ec7e79234920b20756a7
---

# Treat zero retro counters as unmeasured, not clean

Validate mission telemetry before trusting a retrospective.

## Procedure Steps

1. Before reading a mission retrospective as a clean run, sanity-check the stat bundle: (1) dispatch_rounds_observed>0 unless the mission ran as direct CLI — record an explicit execution_mode=direct_cli marker so 0 is distinguishable from lost telemetry; (2) one token_usage entry per task/role invocation, not a single mission-level estimate; (3) an item_outcomes record (deliverable + actor_id + result) appended at each record-evidence/task close — finish should warn or block when task_total>0 and item_outcomes is empty; (4) resource_usage recorded or explicitly marked unmetered. Staffing signal: repeated missions allocated ~50% planner tasks that produced zero clarifications, zero reconciliation and zero rework — rebalance toward implementer/reviewer for this mission shape. Also: a 180s CI timeout that looks flaky may be a real regression — the import-contract test dropped 43s→3s after a genuine fix; measure before dismissing as flake.

## Safety Notes

- Require approval before irreversible or high-risk actions.
- Capture evidence before and after the action.

## Escalation Conditions

- Unexpected runtime failure
- Policy or approval mismatch
- Result does not match the expected state

## Evidence

- active/missions/public/MSN-DISTILL-LEARNINGS-20260923/evidence/retrospective.md
- active/missions/public/MSN-DISTILL-LEARNINGS-20260923/evidence/test-report.md
- active/missions/public/MSN-DISTILL-LEARNINGS-20260923/evidence/delivery-report.md

## Artifacts

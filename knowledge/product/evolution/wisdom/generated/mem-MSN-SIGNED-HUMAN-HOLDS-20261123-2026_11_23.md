---
record_id: mem-MSN-SIGNED-HUMAN-HOLDS-20261123-2026_11_23
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-SIGNED-HUMAN-HOLDS-20261123-2026_11_23
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-23T11:13:27.684Z
source_branch: feat/signed-human-holds-20261123
source_commit: 564ed21c5f41c16f4caf4ded2662db803f79fdf6
---

# Human holds: prove the human decision and guard every writer that releases work

Required human_override holds pass only with a proof backed by an approved human mission_gate request bound to the gate inputs, anchored in several sources, and enforced at every task/phase/dispatch writer, not just the gate.

## Hint Scope

mission

## Trigger Phrases

- ## Lessons

1. A signature is not proof of a human. The agent holds the same local HMAC key (signHumanOverride), so a required hold counts as passed only when its proof record is backed by an approved, human-only mission_gate request. That request must be bound to the mission, the gate and a fingerprint of the gate inputs, and decided by an authenticated human who is the record's approver. Editing the inputs after approval invalidates it.
2. Anchor "which holds are required" in several sources the agent cannot all drop at once: the template in state, the templates matching mission_type, and catalog gate ids found as definition files (catalog gate ids are global). The catalog's phase and phase order always win over a stored definition. A hold or task phase outside the order fails closed.
3. Enforce a hold at every authority-granting writer, not just at the gate. In this case those were record-evidence/review-task auto-complete and cascade, markPhaseTasksStatus('completed'), advanceCurrentPhase, work-item dispatch, the NEXT_TASKS wave dispatcher (after the graph snapshot restore too), the exported dispatch entry points, and finish. Review needed 4 rounds; each NO-GO found one more writer.
4. A filter applied to a list that is rebuilt later is lost. Re-apply it after the rebuild, and put a guard at the exported entry point so future callers are covered.
5. Write the proof only after the gate passes: evaluate with an in-memory record, then persist, so a failing machine check never leaves a valid hold behind.

## How to apply

When you add a human decision that releases mission work, grep every writer of task status and phase (status = 'completed', current_phase, dispatch) and route each one through the same predicate. Test the forged-record case and the mixed-board case.

## Recommended References

- active/missions/public/MSN-SIGNED-HUMAN-HOLDS-20261123/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-SIGNED-HUMAN-HOLDS-20261123/evidence/implementation-report.md
- active/missions/public/MSN-SIGNED-HUMAN-HOLDS-20261123/evidence/test-report.md
- active/missions/public/MSN-SIGNED-HUMAN-HOLDS-20261123/evidence/design-spec.json

## Evidence

- active/missions/public/MSN-SIGNED-HUMAN-HOLDS-20261123/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-SIGNED-HUMAN-HOLDS-20261123/evidence/implementation-report.md
- active/missions/public/MSN-SIGNED-HUMAN-HOLDS-20261123/evidence/test-report.md
- active/missions/public/MSN-SIGNED-HUMAN-HOLDS-20261123/evidence/design-spec.json

## Artifacts

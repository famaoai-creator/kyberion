---
record_id: mem-MSN-VIDEO-WORKFLOW-20261014-2026_10_13
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-VIDEO-WORKFLOW-20261014-2026_10_13
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-13T20:21:32.195Z
source_branch: feat/video-process-reference-20261014
source_commit: 7861979eb70c1dd8bd6cabcd8b318dc150aa069a
---

# Bind production approvals to the exact artifacts and keep request helpers separate

Reusable rules for adding production phase gates without replacing task-owned deliverables or weakening human approval.

## Hint Scope

mission

## Trigger Phrases

- Use typed phase-entry checks to validate scene plans, integer budgets, attempt histories, asset lineage and quality evidence before dispatch. Bind authenticated human decisions to the mission scope and hashes of the specific prototype or render; invalidate stale approvals after relevant artifacts change, while preserving decisions for unchanged scenes. Request-only helpers write separate sidecars and never task deliverables. Check failed and pending attempts as well as selected takes. Test persisted gates with the real isolated shared approval store, including revoked, expired, cross-mission and changed-artifact rejection. Evidence gates validate recorded history; they do not reserve provider billing or govern ad-hoc calls.

## Recommended References

- active/missions/public/MSN-VIDEO-WORKFLOW-20261014/evidence/implementation-report.md
- active/missions/public/MSN-VIDEO-WORKFLOW-20261014/evidence/test-report.md
- active/missions/public/MSN-VIDEO-WORKFLOW-20261014/evidence/REVIEW-execution-implement.md

## Evidence

- active/missions/public/MSN-VIDEO-WORKFLOW-20261014/evidence/implementation-report.md
- active/missions/public/MSN-VIDEO-WORKFLOW-20261014/evidence/test-report.md
- active/missions/public/MSN-VIDEO-WORKFLOW-20261014/evidence/REVIEW-execution-implement.md

## Artifacts

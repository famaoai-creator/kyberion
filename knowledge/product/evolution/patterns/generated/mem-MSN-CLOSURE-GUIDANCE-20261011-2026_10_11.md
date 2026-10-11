---
record_id: mem-MSN-CLOSURE-GUIDANCE-20261011-2026_10_11
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CLOSURE-GUIDANCE-20261011-2026_10_11
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-11T18:49:12.849Z
source_branch: feat/completed-closure-guidance-20261011
source_commit: 8a41b61f5f640c5e18d51965d674c0f5babe709a
---

# Completed lifecycle still needs closure evidence

Read-only mission guidance must distinguish an observed completed lifecycle from task, evidence and independent-review readiness.

## Applicability

- mission
- mission:MSN-CLOSURE-GUIDANCE-20261011

## Reusable Steps

1. Read-only mission guidance must distinguish an observed completed lifecycle from task, evidence and independent-review readiness

## Expected Outcome

When distillation marks a mission completed before delivery and retrospective tasks finish, preserve that lifecycle fact but continue inspecting the strict mission-bound task graph. Missing or malformed observations must fail closed. Guide the first unfinished task to its evidence or independent review workflow; never repair task state during status or triage. All canonical review kinds need current receipts bound to the mission, review task, target artifact and applicable profile, including identity, content hash, verdict and independence. Share pure read-only proof helpers instead of importing mutating governance modules into projections; dependency-boundary gates catch resulting cycles. Offer finish only as an advisory candidate requiring fresh facade validation, and keep legacy CLI recommendations consistent. Test real status and triage in fresh processes against synthetic missing, malformed, pending, review-blocked, ready and archived fixtures; compare full fixture-tree hashes before and after reads. Keep each negative receipt test independent by restoring a valid current artifact and receipt first. This prevents stale evidence from masking incorrect identity tests.

## Evidence

- active/missions/public/MSN-CLOSURE-GUIDANCE-20261011/evidence/implementation-report.md
- active/missions/public/MSN-CLOSURE-GUIDANCE-20261011/evidence/test-report.md

## Artifacts

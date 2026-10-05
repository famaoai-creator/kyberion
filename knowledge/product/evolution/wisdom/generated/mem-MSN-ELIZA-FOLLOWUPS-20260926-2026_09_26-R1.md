---
record_id: mem-MSN-ELIZA-FOLLOWUPS-20260926-2026_09_26-R1
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-ELIZA-FOLLOWUPS-20260926-2026_09_26-R1
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-05T13:30:40.227Z
source_branch: fix/voice-media-session-id-20261005
source_commit: 3914948b3e61c1a44cc2ec7e79234920b20756a7
---

# Bind execution to the approved digest, not to the approval event

Approval-checkpoint integrity rules from a NO-GO review.

## Hint Scope

mission

## Trigger Phrases

- Review found an approval-binding gap: an action approved by a human was executed with preflight-repaired (mutated) input rather than the approved params, and the running module's grant was never compared against the approved grant digest. Rule: approval is a binding to a digest of (action, params, grant context) — at execution time re-hash what will actually run and require equality, otherwise re-request approval. Related review gotchas worth checking anywhere a scope/tenant context can drop: scope loss must fail closed (not open); scenario risky-approval overrides must not approve in every profile; blocked ops must not be counted as called in audit. For follow-up missions specifically, a tightly-defined follow-up scope (FU items with owners) supports one coordinated implementation wave plus targeted review fixes.

## Recommended References

- active/missions/public/MSN-ELIZA-FOLLOWUPS-20260926/evidence/distillation.md
- active/missions/public/MSN-ELIZA-FOLLOWUPS-20260926/evidence/review-round1-findings.md
- active/missions/public/MSN-ELIZA-FOLLOWUPS-20260926/evidence/retrospective.md

## Evidence

- active/missions/public/MSN-ELIZA-FOLLOWUPS-20260926/evidence/distillation.md
- active/missions/public/MSN-ELIZA-FOLLOWUPS-20260926/evidence/review-round1-findings.md
- active/missions/public/MSN-ELIZA-FOLLOWUPS-20260926/evidence/retrospective.md

## Artifacts

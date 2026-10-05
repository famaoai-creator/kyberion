---
record_id: mem-MSN-SCOPE-GOV-UNIFY-20261003-2026_10_05-R1
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-SCOPE-GOV-UNIFY-20261003-2026_10_05-R1
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-05T13:30:11.923Z
source_branch: fix/voice-media-session-id-20261005
source_commit: 3914948b3e61c1a44cc2ec7e79234920b20756a7
---

# Server-side authority must be recomputed at effect-use time

Scope governance lesson from MSN-SCOPE-GOV-UNIFY-20261003 (PR #896): attenuation of an effect may not rely on a stale identity snapshot.

## Hint Scope

mission

## Trigger Phrases

- When an effect is used, recompute authority on the server — an identity snapshot alone must not grant continuing permission. Anchor every effect claim to a journal lock and retain evidence for each governance stage so approval and execution decisions remain auditable. Keep the immutable identity snapshot separate from the attenuable policy in the scope envelope, with a mint-ledger anchor. Also note: task completion is distinct from evidence recording — ledger entries do not clear pending NEXT_TASKS.json tasks.

## Recommended References

- active/missions/public/MSN-SCOPE-GOV-UNIFY-20261003/evidence/distillation.md

## Evidence

- active/missions/public/MSN-SCOPE-GOV-UNIFY-20261003/evidence/distillation.md

## Artifacts

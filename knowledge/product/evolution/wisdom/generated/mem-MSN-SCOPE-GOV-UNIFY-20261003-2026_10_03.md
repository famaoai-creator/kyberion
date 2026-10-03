---
record_id: mem-MSN-SCOPE-GOV-UNIFY-20261003-2026_10_03
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-SCOPE-GOV-UNIFY-20261003-2026_10_03
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-03T10:28:50.279Z
source_branch: feat/scope-envelope-sc01
source_commit: b5814a05c5e67419eb0bab65efe9276c1b9060a4
---

# Scope governance envelopes separate identity from attenuable policy

Governance scope must be minted by the runtime as an immutable identity snapshot (tenant→org→project→mission→task→session) plus an attenuable policy layer; delegation narrows pre-claim and caller metadata is never trusted.

## Hint Scope

mission

## Trigger Phrases

- When unifying scope across systems, mint a two-layer envelope at dispatch boundaries: an immutable identity snapshot resolved from trusted sources, and a policy layer (read_tiers/write_tier/purpose/egress/reasoning_backends) that may only narrow. Persisted control-plane state should be tenant-namespaced append-only journals with locked appends and tail catch-up; snapshots are caches, journals are truth, and tenantless or envelope-contradicting records quarantine with audit. Held effects persist serializable params and rehydrate executors via a registry.

## Recommended References

- active/missions/public/MSN-SCOPE-GOV-UNIFY-20261003/evidence/design-spec.json
- active/missions/public/MSN-SCOPE-GOV-UNIFY-20261003/evidence/distillation.md

## Evidence

- active/missions/public/MSN-SCOPE-GOV-UNIFY-20261003/evidence/design-spec.json
- active/missions/public/MSN-SCOPE-GOV-UNIFY-20261003/evidence/distillation.md

## Artifacts

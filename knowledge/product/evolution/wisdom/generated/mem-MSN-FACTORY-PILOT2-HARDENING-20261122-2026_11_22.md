---
record_id: mem-MSN-FACTORY-PILOT2-HARDENING-20261122-2026_11_22
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-FACTORY-PILOT2-HARDENING-20261122-2026_11_22
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-22T09:08:57.260Z
source_branch: agent/factory-pilot2-hardening
source_commit: 98e5385ad7e51e48661a6fd1832d326793e48612
---

# Contract-driven PR sections and generated-output enrollment

Two Software Factory hardening patterns: scaffold contract-required PR body sections (Coordination/Knowledge) from mission state instead of documenting them, and enroll every generator output in resolve generated tracked paths so drift is gated rather than invisible.

## Hint Scope

mission

## Trigger Phrases

- When a command has a structural contract (pr create Knowledge/Coordination), ship a scaffold command that renders compliant output from mission state — documentation alone fails late. For generators, single-source repeated literal unions via post-processing substitution (exact-match guard + canonical type reference) and register every emitted path in GENERATED_ARTIFACT_STEPS tracked; outputs outside the tracked list are silently unchecked. Pair the registry with a targets≡tracked coverage test so future generator targets cannot rot.

## Recommended References

- active/missions/public/MSN-FACTORY-PILOT2-HARDENING-20261122/evidence/distillation.md
- active/missions/public/MSN-FACTORY-PILOT2-HARDENING-20261122/evidence/retrospective.md

## Evidence

- active/missions/public/MSN-FACTORY-PILOT2-HARDENING-20261122/evidence/distillation.md
- active/missions/public/MSN-FACTORY-PILOT2-HARDENING-20261122/evidence/retrospective.md

## Artifacts

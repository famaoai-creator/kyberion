---
record_id: mem-MSN-ORG-ARTIFACT-PROMOTION-20261002-2026_10_02
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-ORG-ARTIFACT-PROMOTION-20261002-2026_10_02
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-02T14:20:43.921Z
source_branch: claude/org-scope-artifact-promotion
source_commit: a9ad4ad11018987b5d6b65ad0b10f50fff85e9a3
---

# Derive artifact scope from the owner record, never from the caller

Organization-scoped deliverables and mission-to-project promotion only hold the tier/tenant invariant when placement, labels and record ids come from the owner (project record, mission state) and every surface path check parses exactly what it serves. Two independent reviews found each place where a caller-supplied value leaked through.

## Applicability

- mission
- mission:MSN-ORG-ARTIFACT-PROMOTION-20261002

## Reusable Steps

1. Organization-scoped deliverables and mission-to-project promotion only hold the tier/tenant invariant when placement, labels and record ids come from the owner (project record, mission state) and every surface path check parses exactly what it serves
2. Two independent reviews found each place where a caller-supplied value leaked through

## Expected Outcome

- Place a promoted or derived artifact by its destination owner's record (project tier + tenant), and refuse when the source owner is outside that scope (scope_mismatch) — taking tier/tenant from the source mission surfaced confidential deliverables in a public project view.
- Treat a scope-local index as untrusted input: confine copy sources to the owner's own artifacts tree, regular files only (no symlinks or hard links), before reading under a privileged role.
- When a write lands in an existing owner's directory, take the tier label from the owner's state; reject an explicit tier that contradicts it. A defaulted label silently mislabels records and later hides them from correctly-scoped views — derive the tier from where the file lives when labels disagree.
- A caller-chosen (deterministic) record id must be owner-guarded and merged, never blindly replaced; build it from an unambiguous encoding (hash of tier/tenant/owner), not a lossy character mapping.
- Surface routes must authorize the path they serve: reject ./empty segments before parsing owner segments, allow only the deliverable subtree (artifacts/, never state/), and check the viewer's organization scope in addition to tenant and tier.
- An append-only ownership registry needs last-row-wins de-duplication in every view once records can be re-registered.
- A best-effort step inside finish (promotion) must be wrapped like closure: a throw there aborts finish after the state already moved to completed.

## Evidence

- active/missions/public/MSN-ORG-ARTIFACT-PROMOTION-20261002/evidence/implementation-report.md
- active/missions/public/MSN-ORG-ARTIFACT-PROMOTION-20261002/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-ORG-ARTIFACT-PROMOTION-20261002/evidence/test-report.md

## Artifacts

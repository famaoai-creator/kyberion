---
record_id: mem-MSN-SCOPE-FOLLOWUP-REVIEW-20261108-2026_11_07
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-SCOPE-FOLLOWUP-REVIEW-20261108-2026_11_07
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-07T22:15:27.119Z
source_branch: fix/scope-followup-review-20261108
source_commit: 45567f04a6f368512dda96cc4b60a0d41c291400
---

# Preserve owner admission through workspace prefilters

Validate exact owner aliases, keep custody separate from tier and workspace ceilings, and test positive owner paths through every upstream filter.

## Hint Scope

mission

## Trigger Phrases

- Resolve owner_nhi and nhi_id as exact server-governed person bindings. Reject blank, malformed or contradictory claims before applying tenant precedence or public/system carveouts. Retain declared custody through projections; mission tenant fallback must not overwrite a person owner.

A viewer's finite allowed tenant set is not an explicit tenant selection. Without an explicit selection, the authenticated owner may read an otherwise permitted person record. Explicit tenant narrowing excludes tenantless person/system records. Tier, read permission, organization, project and operation ceilings remain independent and cannot be bypassed by ownership.

Test the complete approval path rather than only its final owner check. An upstream workspace prefilter can incorrectly return 404 before a valid owner reaches that check. Pass the server-resolved viewer to the workspace predicate and relax only tenant membership after proving exact person ownership; keep all other ceilings. Retain owner-positive, foreign-owner, malformed-claim, personal-tier, explicit-tenant and workspace-boundary negatives. In PresenceStudio resolve canonical raw/nested classifications before custody admission; absent classification retains the confidential default.

## Recommended References

- active/missions/public/MSN-SCOPE-FOLLOWUP-REVIEW-20261108/evidence/implementation-report.md
- active/missions/public/MSN-SCOPE-FOLLOWUP-REVIEW-20261108/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-SCOPE-FOLLOWUP-REVIEW-20261108/evidence/test-report.md

## Evidence

- active/missions/public/MSN-SCOPE-FOLLOWUP-REVIEW-20261108/evidence/implementation-report.md
- active/missions/public/MSN-SCOPE-FOLLOWUP-REVIEW-20261108/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-SCOPE-FOLLOWUP-REVIEW-20261108/evidence/test-report.md

## Artifacts

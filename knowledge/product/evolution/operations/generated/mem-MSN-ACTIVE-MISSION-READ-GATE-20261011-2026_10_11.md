---
record_id: mem-MSN-ACTIVE-MISSION-READ-GATE-20261011-2026_10_11
kind: sop_candidate
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-ACTIVE-MISSION-READ-GATE-20261011-2026_10_11
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-11T09:11:12.961Z
source_branch: fix/active-mission-read-gate-20261011
source_commit: 0f978c05ecea15d1b00a7e7f9febcfe678a72a92
---

# Scoped read gating: tenant-scope without tier block, and bound-partition probing

How to add a protected root to the io-layer read gate without breaking legit readers: apply checkTenantScope but skip the tier block, and teach every enumerator to probe <tier>/<bound> instead of listing the tier root.

## Procedure Steps

1. (1) validateReadPermission and checkTenantScope are separable: adding a path to the protected set gives you cross-tenant denial for free; the personaTierReadDecision tier block is a second, wider gate you can keep off. (2) Denial is invisible to enumeration: safeExistsSync swallows ROLE_VIOLATION into false and safeLstat/safeReaddir throw — a bound process cannot list a tier root, so every enumerator must probe <tier>/<bound> directly or silently see nothing. (3) Bound identities must not enumerate tenant lists — same rule as knowledge/confidential/; probing your own partition is the legitimate equivalent. (4) Caches over scope-relative views must key by the binding (bound tenant here), or a narrowed view satisfies a wider later lookup. (5) Owner-scope visibility already filters to the bound tenant, so bound-partition probing is not a behavior change — only the io contract catches up.

## Safety Notes

- Require approval before irreversible or high-risk actions.
- Capture evidence before and after the action.

## Escalation Conditions

- Unexpected runtime failure
- Policy or approval mismatch
- Result does not match the expected state

## Evidence

- active/missions/public/MSN-ACTIVE-MISSION-READ-GATE-20261011/evidence/implementation-report.md
- active/missions/public/MSN-ACTIVE-MISSION-READ-GATE-20261011/evidence/design-spec.json

## Artifacts

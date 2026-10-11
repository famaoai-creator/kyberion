---
record_id: mem-MSN-GOLDEN-ISOLATION-20261011-2026_10_11
kind: sop_candidate
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-GOLDEN-ISOLATION-20261011-2026_10_11
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-11T20:12:19.059Z
source_branch: fix/golden-env-isolation-20261011
source_commit: 3230afe0611738a6d815886d2a9cd6cd4006f35a
---

# Golden-gate drift is often a bound-scope enumerator defect — fix the enumerator, not the snapshot

baseline-check/vital-check golden comparisons failed only on live checkouts: bound processes enumerated protected mission tier roots and threw scope_invalid_prefix, flipping step status. Routing the three enumerators through missionTierScanDirs made the golden output identical bound or unbound — and fixed a hidden bug where tenant dirs were reported as missions.

## Procedure Steps

1. (1) When a golden/deterministic check drifts only on live checkouts, suspect a scope-binding difference (bound vs unbound) before touching the snapshot. (2) Runbook rules do not migrate old code — recurring defect classes need either a gate or a sweep; here the sweep found list_missions, watch_tenant_drift, virtual_office. (3) Reproduce bound-scope bugs deterministically with KYBERION_TENANT + a partitioned fixture inside the worktree; mock getAllFiles to assert the probe target instead of relying on filesystem state.

## Safety Notes

- Require approval before irreversible or high-risk actions.
- Capture evidence before and after the action.

## Escalation Conditions

- Unexpected runtime failure
- Policy or approval mismatch
- Result does not match the expected state

## Evidence

- active/missions/public/MSN-GOLDEN-ISOLATION-20261011/evidence/test-report.md
- active/missions/public/MSN-GOLDEN-ISOLATION-20261011/evidence/retrospective.md

## Artifacts

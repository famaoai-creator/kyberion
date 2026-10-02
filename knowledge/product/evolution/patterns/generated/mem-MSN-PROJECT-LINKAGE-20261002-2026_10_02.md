---
record_id: mem-MSN-PROJECT-LINKAGE-20261002-2026_10_02
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-PROJECT-LINKAGE-20261002-2026_10_02
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-02T13:04:54.548Z
source_branch: claude/project-mission-linkage
source_commit: 4184305a8b953c542b87054aa84fb404343bf34e
---

# Derived membership needs one source, one rule, and a sync that can actually run

Project-mission membership drifted because four stores were each accumulated independently; finished missions never left and tracks kept only the last mission. Fix by deriving every projection from mission state on each sync, with the same rule reconcile uses. E2E then showed the sync had never persisted from the CLI at all (all-tier walk and a missing role grant were swallowed as warnings).

## Applicability

- mission
- mission:MSN-PROJECT-LINKAGE-20261002

## Reusable Steps

1. Project-mission membership drifted because four stores were each accumulated independently; finished missions never left and tracks kept only the last mission
2. Fix by deriving every projection from mission state on each sync, with the same rule reconcile uses
3. E2E then showed the sync had never persisted from the CLI at all (all-tier walk and a missing role grant were swallowed as warnings)

## Expected Outcome

- Membership projections (operational state, track state, record lists) must be recomputed from the single source on every sync, never appended to; otherwise removals (finished missions, track moves) never happen.
- Sync and reconcile must share one rule (e.g. registered empty active tracks, tenantless tracks inheriting the project tenant), or the two flip each other forever.
- A system projection must not reuse a caller-scoped view (worker persona narrows projectMissions to its own mission) — scan the source directly.
- Read only your own scope: an all-tier directory walk fails for roles that may not see higher tiers and takes the whole sync down.
- A sync whose failure is downgraded to a warning needs an E2E check that it persisted; here every CLI-driven project sync had been silently skipped for lack of a mission_controller grant on active/projects/.
- Patch shared records field-by-field after a fresh re-read; never write back an object loaded at the start of a long operation.

## Evidence

- active/missions/public/MSN-PROJECT-LINKAGE-20261002/evidence/distillation.md

## Artifacts

---
record_id: mem-MSN-PROJECT-SYMMETRY-20261008-2026_10_08
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-PROJECT-SYMMETRY-20261008-2026_10_08
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-08T14:42:18.592Z
source_branch: fix/project-lifecycle-symmetry-20261008
source_commit: bd8dac42497939c3c568eae54be8a74c9ccca20b
---

# Share guarded lifecycle transitions across project entry points

Dedicated lifecycle verbs and generic status updates must share guard, scope, reconciliation and rollback rules.

## Hint Scope

mission

## Trigger Phrases

- For project and track lifecycle changes, route dedicated CLI verbs and generic status patches through one typed facade. Before archiving a project, inspect live scoped missions, sessions and unfinished tracks; never erase ownership links to simulate completion. Only an explicit restore may leave archived project state, and it must validate the linked organization in the same tenant and tier. Project workers cannot prove sibling missions are finished, so lifecycle mutations require the owner. After track transitions, reconcile active/default track projections and retain rollback when audit or reconciliation fails. Reject unsupported lifecycle CLI options, especially --dry-run, rather than silently writing. Regression verification must cover each entry point, active work, scoped restore, worker denial, rollback and final projections. Run strict state-leak checks in isolation: concurrent CLI process/lock logging can contaminate their snapshots. Keep these responsibilities in small internal modules; do not raise file-size baselines to ship lifecycle changes.

## Recommended References

- active/missions/public/MSN-PROJECT-SYMMETRY-20261008/evidence/implementation-report.md
- active/missions/public/MSN-PROJECT-SYMMETRY-20261008/evidence/test-report.md
- active/missions/public/MSN-PROJECT-SYMMETRY-20261008/evidence/REVIEW-execution-implement.md

## Evidence

- active/missions/public/MSN-PROJECT-SYMMETRY-20261008/evidence/implementation-report.md
- active/missions/public/MSN-PROJECT-SYMMETRY-20261008/evidence/test-report.md
- active/missions/public/MSN-PROJECT-SYMMETRY-20261008/evidence/REVIEW-execution-implement.md

## Artifacts

---
record_id: mem-MSN-LEARNING-SIGNAL-OWNER-20261125-2026_11_24
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-LEARNING-SIGNAL-OWNER-20261125-2026_11_24
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-24T23:45:16.416Z
source_branch: fix/learning-signal-owner-20261125
source_commit: 6cb6548312ec53d103155947ac4e11c5e4561602
---

# Prove every new queue scope shape against the real store, and report waiting work per item, not per run

Personal operational-learning candidates were dropped on every run for two weeks: the organization-learning scope put organization_id on tenant-free scopes, which scope-context validation always rejects, and every test mocked the queue. An owner fix alone would have looked green. A fixed ops-alert dedupe key also did not make 'report once' true, because its 10-minute window is shorter than the hourly baseline.

## Hint Scope

mission

## Trigger Phrases

- ## Pattern

1. When a change makes a producer write a new scope shape (a new tier, owner, or tenant-free variant), add one test that runs the real store path (operating model -> store grant -> memory queue) with only configuration stubbed. Mocked enqueue tests cannot see `assertMemoryScope` rejections.
2. An entity id below the tenant (`organization_id`, `project_id`) needs its parent in the scope chain. On a tenant-free scope, carry such ids in `origin.attributes` and give the reader a fallback; never put them in `scope`.
3. A recurring 'dropped' ops alert keyed per learning id is a scope defect signal, not noise: read `ops-alerts.jsonl` for `Learning candidate dropped` before assuming a producer-side cause.
4. 'Report once' needs per-item state (e.g. `owner_pending_at` on the cluster), not an ops-alert `dedupe_key`; the default dedupe window is 10 minutes and scheduled harvests are hourly. Items waiting on a precondition should be re-evaluated when it is met, even without a recurrence.

## Evidence

`libs/core/organization/organization-learning-queue.ts` (`organizationLearningScope`), `libs/core/knowledge/operational-learning-owner.test.ts`, `libs/core/knowledge/learning-signal-adapter.ts` (`owner_pending_at`).

## Recommended References

- active/missions/public/MSN-LEARNING-SIGNAL-OWNER-20261125/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-LEARNING-SIGNAL-OWNER-20261125/evidence/implementation-report.md
- active/missions/public/MSN-LEARNING-SIGNAL-OWNER-20261125/evidence/test-report.md

## Evidence

- active/missions/public/MSN-LEARNING-SIGNAL-OWNER-20261125/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-LEARNING-SIGNAL-OWNER-20261125/evidence/implementation-report.md
- active/missions/public/MSN-LEARNING-SIGNAL-OWNER-20261125/evidence/test-report.md

## Artifacts

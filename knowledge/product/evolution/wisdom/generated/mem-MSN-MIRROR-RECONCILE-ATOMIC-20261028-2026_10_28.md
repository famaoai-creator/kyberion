---
record_id: mem-MSN-MIRROR-RECONCILE-ATOMIC-20261028-2026_10_28
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-MIRROR-RECONCILE-ATOMIC-20261028-2026_10_28
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-28T03:25:41.566Z
source_branch: fix/mirror-reconcile-atomic-20261028
source_commit: 00ed19f9ad1a0fc51db529a0324f9150f27166c5
---

# An effect atomic with audit appends takes the record lock, then the audit lock

To act only on approved audit state, hold the audit chain append lock from a recheck through the effect; take the approval record lock first (the order revoke uses) and run audit-writing checks before the audit lock, because it is not reentrant.

## Hint Scope

mission

## Trigger Phrases

- Every audit append writes the master chain and the tenant mirror under the audit chain lock (AUDIT_CHAIN_LOCK_ID). An effect that must see no append between its check and its action (mirror reconcile) holds that lock from a recheck of the approved findings hash through the archive and rebuild, and refuses with nothing applied if the hash changed. The lock is not reentrant: any audit entry recorded under it (a separation-of-duties refusal, a policy-denied write) waits out the 5 s budget and fails with a misleading error. So take the approval record lock first, as revoke does, run the approval checks there (consumeApprovalWithin), then take the audit lock and consume inside it. A consume callback must be marked used before its first write and refused after the record lock is released. Parse the master once under the lock to keep the hold short. Verify both properties with mutation checks: removing the recheck, and taking the audit lock outside the record lock (shows as a 5 s wait).

## Recommended References

- active/missions/public/MSN-MIRROR-RECONCILE-ATOMIC-20261028/evidence/design-spec.json
- active/missions/public/MSN-MIRROR-RECONCILE-ATOMIC-20261028/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-MIRROR-RECONCILE-ATOMIC-20261028/evidence/test-report.md
- active/missions/public/MSN-MIRROR-RECONCILE-ATOMIC-20261028/evidence/retrospective.md

## Evidence

- active/missions/public/MSN-MIRROR-RECONCILE-ATOMIC-20261028/evidence/design-spec.json
- active/missions/public/MSN-MIRROR-RECONCILE-ATOMIC-20261028/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-MIRROR-RECONCILE-ATOMIC-20261028/evidence/test-report.md
- active/missions/public/MSN-MIRROR-RECONCILE-ATOMIC-20261028/evidence/retrospective.md

## Artifacts

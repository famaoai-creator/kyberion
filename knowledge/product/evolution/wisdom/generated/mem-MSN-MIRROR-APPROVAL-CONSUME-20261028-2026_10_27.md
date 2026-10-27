---
record_id: mem-MSN-MIRROR-APPROVAL-CONSUME-20261028-2026_10_27
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-MIRROR-APPROVAL-CONSUME-20261028-2026_10_27
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-27T20:21:47.380Z
source_branch: fix/mirror-approval-consume-20261028
source_commit: 5007e4127607e9a2aaff0da235dc670efc4494ea
---

# A one-shot effect consumes its approval under the store lock

An approval bound by a payload hash stops a replay only while the bound state differs; a one-shot effect must also consume the approval under the store lock, before the effect, and a test must reach that lock past any friendly pre-check.

## Hint Scope

mission

## Trigger Phrases

- When an approved request authorizes a one-shot effect (archive, rebuild, grant, promotion), binding it to a payload hash is not enough: if the same state recurs, the hash matches again and the old approval would apply again. Call markApprovalConsumed with a literal consumer id before the effect, so the record lock refuses a second consumer and two concurrent applies cannot both run; a failed effect then needs a new approval. A pre-check that refuses a used approval gives a clear message but hides the lock from tests, so add a test where the consumer read the record before it was consumed (a stale read stand-in) and confirm by removing the consume that the tests fail. Keep the receipt and the consumption naming the same human decider.

## Recommended References

- active/missions/public/MSN-MIRROR-APPROVAL-CONSUME-20261028/evidence/design-spec.json
- active/missions/public/MSN-MIRROR-APPROVAL-CONSUME-20261028/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-MIRROR-APPROVAL-CONSUME-20261028/evidence/test-report.md
- active/missions/public/MSN-MIRROR-APPROVAL-CONSUME-20261028/evidence/retrospective.md

## Evidence

- active/missions/public/MSN-MIRROR-APPROVAL-CONSUME-20261028/evidence/design-spec.json
- active/missions/public/MSN-MIRROR-APPROVAL-CONSUME-20261028/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-MIRROR-APPROVAL-CONSUME-20261028/evidence/test-report.md
- active/missions/public/MSN-MIRROR-APPROVAL-CONSUME-20261028/evidence/retrospective.md

## Artifacts

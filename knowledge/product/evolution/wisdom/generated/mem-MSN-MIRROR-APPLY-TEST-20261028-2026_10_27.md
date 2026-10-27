---
record_id: mem-MSN-MIRROR-APPLY-TEST-20261028-2026_10_27
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-MIRROR-APPLY-TEST-20261028-2026_10_27
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-27T19:03:45.945Z
source_branch: test/audit-mirror-apply-20261028
source_commit: 1e071f3820861af59da80d8b6bb9eeafb54892b0
---

# A gate test must reach the gate under test

When a governed operation is protected by several layers (store-level decision validation, then the operation's own recheck), a refusal test must get past the earlier layers and assert the specific message of the layer it claims to test.

## Hint Scope

mission

## Trigger Phrases

- Design rule for testing approval gates: an approval store may refuse an unauthenticated or non-human decision before it is ever stored, so a test that only tries such a decision proves the store guard, not the consuming operation's recheck (e.g. audit_mirror_reconcile's 'SA-01 requires an authenticated human approval'). To test the recheck, make a valid decision, then tamper the stored decision entry, confirm the record still loads as approved, and assert the recheck's exact message plus that nothing was changed. Loose matchers such as /POLICY_VIOLATION/ hide which layer refused. Companion rule: when telling a human what an operation will drop (entries that survive only in an archive), compute it against what is actually lost, keyed on content identity (id and hash) across every readable source, not on id within one partition.

## Recommended References

- active/missions/public/MSN-MIRROR-APPLY-TEST-20261028/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-MIRROR-APPLY-TEST-20261028/evidence/retrospective.md

## Evidence

- active/missions/public/MSN-MIRROR-APPLY-TEST-20261028/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-MIRROR-APPLY-TEST-20261028/evidence/retrospective.md

## Artifacts

---
record_id: mem-MSN-DISCUSSION-REAL-FLOW-20261018-2026_10_18
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-DISCUSSION-REAL-FLOW-20261018-2026_10_18
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-18T15:06:38.303Z
source_branch: fix/discussion-real-flow-20261018
source_commit: 9f145b73d8dff9439cbfe57f8f74aa0257c51d1f
---

# Bounded model flows need transport receipts and exact saved-byte evidence

A terminal UI status alone proves neither model execution nor successful publication. Record the selected transport and observed response separately, and verify saved bytes before claiming publication succeeded.

## Applicability

- mission
- mission:MSN-DISCUSSION-REAL-FLOW-20261018

## Reusable Steps

1. A terminal UI status alone proves neither model execution nor successful publication
2. Record the selected transport and observed response separately, and verify saved bytes before claiming publication succeeded

## Expected Outcome

# Bounded model flows need transport receipts and exact saved-byte evidence

A room reaching a terminal status is not sufficient evidence of model execution or artifact publication.

- Keep scripted behavior explicit and visibly offline. Never substitute it after a real-provider request fails.
- Resolve one governed isolated adapter, preserve the room's tenant/tier egress policy, and disclose unresolved runtime prerequisites before launch. Pasted public text does not change the room's data tier or authorize a provider.
- Count logical provider invocations separately from internal model turns and API requests. A single-model brief can use one structured generation followed by deterministic assembly; do not present it as panel consensus.
- Persist requested and observed provenance, attempts and terminal failures. Leave exact model identity unknown when the transport does not report it.
- Reserve execution durably before invoking the provider. Do not automatically resend an uncertain or interrupted call; document the availability cost of requiring a new explicit room.
- Treat generation success and publication success as separate outcomes. If generation succeeds but saving fails, preserve the generated decision, report partial failure, and never rerun the model to conceal the storage failure.
- Retrieve saved outputs through the authorized room and canonical artifact record. Reject scope, path, symlink, size and digest mismatches; distinguish exact saved bytes from a freshly generated review view.
- Exercise production behavior with mocked boundary failures and governed filesystem round trips. State explicitly that those tests and SSR assertions do not prove a live browser/provider journey.
- Run the application-specific TypeScript check when a framework build skips it or the repository-level check excludes that application.

This pattern was locally validated with mocked provider/authority boundaries and storage readback tests. The associated implementation did not establish live model or rendered-browser execution.

## Evidence

- active/missions/public/MSN-DISCUSSION-REAL-FLOW-20261018/evidence/implementation-report.md
- active/missions/public/MSN-DISCUSSION-REAL-FLOW-20261018/evidence/test-report.md
- active/missions/public/MSN-DISCUSSION-REAL-FLOW-20261018/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-DISCUSSION-REAL-FLOW-20261018/evidence/REVIEW-contract_authoring-ux-contract.md
- active/missions/public/MSN-DISCUSSION-REAL-FLOW-20261018/evidence/demo-checklist.md

## Artifacts

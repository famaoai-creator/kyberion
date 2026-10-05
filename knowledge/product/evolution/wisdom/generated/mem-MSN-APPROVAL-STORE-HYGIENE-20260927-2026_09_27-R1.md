---
record_id: mem-MSN-APPROVAL-STORE-HYGIENE-20260927-2026_09_27-R1
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-APPROVAL-STORE-HYGIENE-20260927-2026_09_27-R1
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-05T13:32:59.146Z
source_branch: fix/voice-media-session-id-20261005
source_commit: 3914948b3e61c1a44cc2ec7e79234920b20756a7
---

# Approval store hygiene: isolate test roots, expire stale pendings, purge to trash, close tasks before finish

Rules for keeping operational stores clean of test data, plus the finish-gate task-closure gotcha.

## Hint Scope

mission

## Trigger Phrases

- Store hygiene rules: (1) Route store roots through an env-aware helper (approvalStoreRoots): under VITEST, write to active/shared/runtime/vitest-approvals/ so suites can never touch production records; any code building approval paths must use the logical-path helpers, never hard-coded channel paths. (2) Share fixture-detection rules between census and cleanup — a new leak signature gets added once. (3) Expire stale pending requests (expiresAt passed, or no-expiry older than ~14d); an expired request can no longer be decided and no-expiry gates re-request. Pipeline-owned pendings are skipped — the pipeline's own timeout decides. (4) Purge fixtures by moving records to trash with an audit line naming the matched rule; dry-run by default, --apply stays with the operator (sovereign persona writes trash). (5) Policy auto-approvals record decidedByType: service, decidedBy: policy:<id>, authenticated: false — never stamp them human. Separately: checkpoint/record-evidence only append to the ledger — they do not flip NEXT_TASKS.json status; close every task (deliverable + record-evidence + review-task by a different agent) before the finish gate.

## Recommended References

- active/missions/public/MSN-APPROVAL-STORE-HYGIENE-20260927/evidence/implementation-report.md
- active/missions/public/MSN-APPROVAL-STORE-HYGIENE-20260927/evidence/retrospective.md
- active/missions/public/MSN-APPROVAL-STORE-HYGIENE-20260927/evidence/distillation.md

## Evidence

- active/missions/public/MSN-APPROVAL-STORE-HYGIENE-20260927/evidence/implementation-report.md
- active/missions/public/MSN-APPROVAL-STORE-HYGIENE-20260927/evidence/retrospective.md
- active/missions/public/MSN-APPROVAL-STORE-HYGIENE-20260927/evidence/distillation.md

## Artifacts

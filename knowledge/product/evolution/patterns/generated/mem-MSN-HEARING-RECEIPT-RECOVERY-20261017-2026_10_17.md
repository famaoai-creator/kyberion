---
record_id: mem-MSN-HEARING-RECEIPT-RECOVERY-20261017-2026_10_17
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-HEARING-RECEIPT-RECOVERY-20261017-2026_10_17
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-17T16:29:20.714Z
source_branch: qa/hearing-receipt-published
source_commit: f04aa937f6ecbc22c2c8d2f0d928121ed932ddb4
---

# Keep durable decision proof inside a protected transaction boundary

Exact operation receipts must share the decision commit, and durable runtime isolation must cover both scoped records and aggregate directory operations.

## Applicability

- mission
- mission:MSN-HEARING-RECEIPT-RECOVERY-20261017

## Reusable Steps

1. Exact operation receipts must share the decision commit, and durable runtime isolation must cover both scoped records and aggregate directory operations

## Expected Outcome

## When to apply
Use this pattern when a state-changing request can complete even though its response is lost.

## Procedure
Commit the receipt with the decision and monotonic revision in one atomic record. Match the exact operation payload, authenticated actor, server-derived scope, scenario and requirements revision. Missing receipts remain unknown; historical receipts never restore current decision authority or trigger downstream resend.

Move legacy temporary state only on an explicit mutation using a staged directory under the common writer lock. Once canonical state exists, missing or corrupt contents fail closed rather than falling back to stale temporary files. Keep receipt evidence under reviewed retention and outside automatic offboarding.

Register tier and tenant boundaries for the durable store and fail closed on missing, corrupt or incomplete protection declarations. Check aggregate move/removal at every ancestor and canonical alias; tier sentinels must precede descendant enumeration so tenant-bound authority cannot widen through a concurrent insertion.

Expose closed data-only storage operations. Clone inputs before temporary role entry. Never invoke arbitrary callbacks while elevated: rejecting their Promise afterward cannot retract inherited async authority. Keep model calls and downstream effects outside.

## Verification
Exercise the real logical storage root under production identity, then cross-tenant/tier denial, aggregate relocation, malformed policy, staged migration failures, restart, concurrent same-operation replay, and current-versus-historical status. Freeze test files before a clean full build. Report blocked browser or IPC checks separately from passing tests.

## Limits
Shared filesystem/PID and coordinated writer upgrade remain required. Atomic publication is not a power-loss or multi-host guarantee, and complete privileged deletion of canonical storage destroys the recovery marker.

## Evidence

- active/missions/public/MSN-HEARING-RECEIPT-RECOVERY-20261017/evidence/lessons-source.md
- active/missions/public/MSN-HEARING-RECEIPT-RECOVERY-20261017/evidence/implementation-report.md
- active/missions/public/MSN-HEARING-RECEIPT-RECOVERY-20261017/evidence/test-report.md
- active/missions/public/MSN-HEARING-RECEIPT-RECOVERY-20261017/evidence/REVIEW-execution-implement.md

## Artifacts

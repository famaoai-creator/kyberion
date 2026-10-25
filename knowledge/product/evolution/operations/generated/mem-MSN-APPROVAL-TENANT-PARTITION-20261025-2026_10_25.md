---
record_id: mem-MSN-APPROVAL-TENANT-PARTITION-20261025-2026_10_25
kind: sop_candidate
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-APPROVAL-TENANT-PARTITION-20261025-2026_10_25
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-25T13:35:36.759Z
source_branch: fix/approval-store-tenant-partition-20261025
source_commit: cba53b7f08d2f67aed3e90d1b368c006d5a4b643
---

# Partitioning a governed store behind a role switch: keep the caller's confinement and close default_allow

When moving records into per-tenant partitions accessed through a tenant-bound store role, re-check the caller's original per-channel grant before switching roles, and make the partition root writable only by the store role — protected prefixes alone do not stop unbound writers under default_allow.

## Procedure Steps

1. ## Context

Tenant-scoped approval requests moved from the shared coordination tree into active/shared/runtime/tenant-approvals/<tier>/<tenant>/, read and written through the tenant-bound role tenant_approval_store, behind an unchanged (channel, id) API.

## Lessons

1. A store role that covers the whole partition silently widens authority: callers previously confined to one channel (slack_bridge → channels/slack/) could decide records on any channel once I/O ran as the store role. Before assuming the store role, validate the caller's write grant on the equivalent LIVE system path (not the Vitest-isolated root, which default_allow always passes).
2. tenant_scope.protected_prefixes only stops processes bound to another tenant. An unbound process with any role still writes under active/shared/runtime/ through default_allow. For roots that hold authority (approvals) or audited evidence (tenant ledger), register them in a tenant-store registry (storage-layout.ts TENANT_STORE_LEDGER_ROOTS) so only the store role, the persona's own grant or scoped SUDO may write.
3. Vitest's isolated store root hides grant gaps: customer-decision reminders cancelled slack approvals as surface_runtime, which has no grant on the live slack channel. A live-path permission check surfaced it.
4. When a lookup gains new ways to return 'not found' (partition listing failure, another tenant binding), audit every caller that treats 'not found' as permissive — e.g. a session-cache grant whose seed cannot be found must be unusable for tenant seeds.
5. Re-locate and re-read under the record lock for every mutation; a caller's stale copy written back can revert a human decision.
6. Migrations between locations: lock, write + fsync, read back, then remove the source; move dependent files (passkey challenges) in the same locked step; document the brief window where lock-free readers see both copies.

## How to apply

Copy the D9 tenant-ledger / tenant-approvals pattern for any new per-tenant runtime store: ledger-root registration, protected prefixes, tenant-bound store role plus a names-only index reader, tenant-store write rule, retention entry, offboarding target, VITEST_LIVE_SUBTREES, and a hermetic boundary test asserting both cross-tenant reads and unbound raw writes are denied.

## Safety Notes

- Require approval before irreversible or high-risk actions.
- Capture evidence before and after the action.

## Escalation Conditions

- Unexpected runtime failure
- Policy or approval mismatch
- Result does not match the expected state

## Evidence

- active/missions/public/MSN-APPROVAL-TENANT-PARTITION-20261025/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-APPROVAL-TENANT-PARTITION-20261025/evidence/implementation-report.md
- active/missions/public/MSN-APPROVAL-TENANT-PARTITION-20261025/evidence/retrospective.md
- active/missions/public/MSN-APPROVAL-TENANT-PARTITION-20261025/evidence/design-spec.json
- active/missions/public/MSN-APPROVAL-TENANT-PARTITION-20261025/evidence/test-report.md

## Artifacts

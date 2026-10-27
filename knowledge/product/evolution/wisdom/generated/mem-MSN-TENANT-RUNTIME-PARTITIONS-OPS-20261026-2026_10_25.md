---
record_id: mem-MSN-TENANT-RUNTIME-PARTITIONS-OPS-20261026-2026_10_25
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-TENANT-RUNTIME-PARTITIONS-OPS-20261026-2026_10_25
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-25T19:04:41.149Z
source_branch: fix/tenant-backup-partitions-20261026
source_commit: f47799cf8d94f35627f8bc319ab18a2fd396e8d5
---

# Backing up and restoring per-tenant runtime partitions without reviving revoked state or forging chains

Enumerate tenant runtime partitions from one registry shared by backup and offboarding; restore revocable state only into quarantine via staging; pin chain algorithm and key id when verifying restored ledgers; check tar member types; verify exclusions without touching live files; clean plaintext temp on every path.

## Hint Scope

mission

## Trigger Phrases

- ## Context

Tenant backups skipped every partitioned runtime root (ledgers, approvals, invites, grants, metrics). The fix also changed offboarding and the system ledger for unplaceable mission ids.

## Lessons

1. One registry-backed enumeration (storage-layout TENANT_RUNTIME_PARTITION_ROOTS) shared by backup and offboarding, with a `satisfies Record<Key, Kind|null>` disposition table, makes a forgotten root a compile error.
2. Never extract revocable state (grants, invites) in place and quarantine afterwards: tar overwrites a revoked record with the older active one and concurrent readers see it. Stage the archive's members, then move only those into a quarantine folder.
3. Verifying a restored hash chain must pin `chain_alg === hmac-sha256` and the manifest's `chain_key_id` on every entry; per-entry algorithm selection lets a keyless rewrite verify. Truncation is undetectable without a head anchor — refuse to overwrite existing append-only files instead.
4. List archive members with type (`tar -tvzf`) and refuse anything but files and directories (bsdtar prints `h…link to` for hard links).
5. `--exclude` is fail-open; check its effect on the archive's own members only, and on a breach move those aside and fail — never rewrite or delete, since live writers may have changed the folder.
6. Plaintext temp dirs (decrypted payloads, staging) need try/finally cleanup and unique names; tenant data must not linger in unpartitioned floors.
7. When a ledger record cannot be placed, write metadata plus a domain-separated keyed digest instead of the payload.

## How to apply

Any new per-tenant runtime root: add it to the registry, choose its offboarding kind in the disposition table, decide whether it is append-only (conflict check) or revocable (quarantine on restore).

## Recommended References

- active/missions/public/MSN-TENANT-RUNTIME-PARTITIONS-OPS-20261026/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-TENANT-RUNTIME-PARTITIONS-OPS-20261026/evidence/implementation-report.md
- active/missions/public/MSN-TENANT-RUNTIME-PARTITIONS-OPS-20261026/evidence/retrospective.md
- active/missions/public/MSN-TENANT-RUNTIME-PARTITIONS-OPS-20261026/evidence/design-spec.json
- active/missions/public/MSN-TENANT-RUNTIME-PARTITIONS-OPS-20261026/evidence/test-report.md

## Evidence

- active/missions/public/MSN-TENANT-RUNTIME-PARTITIONS-OPS-20261026/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-TENANT-RUNTIME-PARTITIONS-OPS-20261026/evidence/implementation-report.md
- active/missions/public/MSN-TENANT-RUNTIME-PARTITIONS-OPS-20261026/evidence/retrospective.md
- active/missions/public/MSN-TENANT-RUNTIME-PARTITIONS-OPS-20261026/evidence/design-spec.json
- active/missions/public/MSN-TENANT-RUNTIME-PARTITIONS-OPS-20261026/evidence/test-report.md

## Artifacts

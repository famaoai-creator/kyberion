---
category: Security
---

- **Tenant audit mirror verified through a dedicated reader grant** — `verifyTenantMirrors` now reads each tenant's mirror partition (`active/shared/runtime/audit-mirror/confidential/<tenant>/`) as `audit_mirror_reader`, a new tenant-bound read-only store grant, instead of under the caller's identity. Verification of the chain no longer fails with `[ROLE_VIOLATION]` for callers without confidential-tier read (the nightly `audit-verify-daily` schedule failed permanently on this). A process bound to another tenant cannot bind the reader: that partition is counted as `withheld` and never read, matching the D9 tenant-ledger semantics (`tenant ledgers withheld` / `tenantMirrors.withheld` in the verify report). No action needed.

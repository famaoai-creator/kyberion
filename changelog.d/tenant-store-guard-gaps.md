---
category: Security
---

- **Three tenant partitions are now tenant-scoped, and ledger partitions keep their tier** — `active/projects/personal/<tenant>/` and `active/shared/runtime/surface-management/{personal,confidential}/<tenant>/` gained tenant-scope protected prefixes, so a caller bound to another tenant can no longer read or write them (unbound and same-tenant callers are unchanged). `detectTier` now reads the tier of the authority-evidence ledger partitions (tenant ledger, tenant approvals, audit mirror) and of surface management from the path instead of reporting `public` (the usage and execution-metrics ledgers keep their legacy public classification), so the provider egress and git publication checks no longer treat a confidential ledger partition as public. Found by comparing the store catalog with tier-guard (G1); `tests/tenant-store-guard-gaps.test.ts` now fails on any new unscoped or misread tenant partition.

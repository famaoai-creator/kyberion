---
category: Fixed
---

- **Tenant registry consistency accepts archived lifecycle** — `check:tenant-registry` no longer reports drift for archived tenants (non-active profiles intentionally fail `resolveTenant`) or tenant references held by archived projects. This unblocks winding down superseded tenants end-to-end.

---
category: Added
---

- **`pnpm scope inspect <path> --compare-identity`** — compares the read decision with the custody ceiling of the process's own resolved identity (its tenant binding and approved broker tenants; `assetReadCeilingFor` in `@agent/core/governance/asset-scope-inspection`), and reports whether the path lies within it. The ceiling never comes from a flag value and grants nothing; an identity bound to no tenant reports `identity_unbound`. This is step 1 of the store-catalog guard's `decide`, compared against tier-guard: across every tenant store, the guard allows a cross-tenant read outside the ceiling only on the three known unprotected partitions (`active/projects/personal`, `runtime/surface-management` personal and confidential).

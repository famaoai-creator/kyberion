---
category: Fixed
---

- **Tenant audit mirror under a company stance** — `pnpm work create-item` (and any other audit record emitted inside a core store-writer role) no longer logs `[AUDIT_CHAIN] Tenant mirror failed … infrastructure_sentinel`. The audit chain now writes `customer/<slug>/logs/audit/` as its own store-writer, bound to the entry's tenant, so the mirror no longer misses entries that the master chain holds. No action needed. A mirror that already lost entries still reports `tenant_mirror_count_mismatch` in `pnpm audit:verify`.
- **Test runs no longer write `knowledge/personal/tenants/default.json`** — mission creation skips the default-tenant bootstrap under Vitest. The Vitest leak guard now also reports writes under `knowledge/personal/`, `knowledge/confidential/` and `customer/`.

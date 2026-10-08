---
category: Security
---

- **Tenant audit mirror written by a dedicated role** — the audit chain now writes `customer/<slug>/logs/audit/` as `audit_mirror_writer`, a new role bound to the entry's tenant whose only grant is that one tenant's mirror directory. `infrastructure_sentinel` (used by coordination stores and by resident dots such as repo-guardian) no longer has any write access under `customer/`. No action needed. If you added your own grant on that path for `infrastructure_sentinel` in a customer overlay policy, move it to `audit_mirror_writer`.

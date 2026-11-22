---
category: Added
---

- **Confidential tenant overlay support for Software Factory autonomy policy** — updated `libs/core/governance/factory-policy.ts` to merge per-tenant opt-in configurations from `knowledge/confidential/<slug>/governance/factory-autonomy-policy.json` while keeping the public product catalog at `"tenants": {}` and ignoring cross-tenant keys.

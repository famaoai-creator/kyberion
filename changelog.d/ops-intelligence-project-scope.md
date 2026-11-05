---
category: Fixed
---

- `/ops` mission intelligence shows project lineage again. Since 2026-09-29 the project view failed on every poll with `[PROJECT_SCOPE_MISSING]`, because the server runs as a worker persona. The route already narrows projects to the viewer's tenants and tiers, and now reads each view as `sovereign_concierge` bound to that project's tenant.

---
category: Fixed
---

- **Project-level tenant knowledge now reaches missions.** A confidential mission's context pack searched only the tenant root and the mission's own folder, because the organization and project were not passed to tenant retrieval. Documents placed with `pnpm knowledge place --project …` (under `knowledge/confidential/{tenant}/organizations/{org}/projects/{project}/`) are now delivered to that project's missions. Sibling projects stay out of scope, and knowledge-gap records now carry the organization and project too.
- **`knowledge/confidential/common/` now reaches confidential workers.** Tenant retrieval found common documents, but the pack's scope gate then dropped them because they carry no tenant of their own, so they only showed up as `scope_audit` rejections. The gate now admits them for a registered tenant whose profile does not set `strict_isolation`. Strict-isolation and unregistered tenants still receive none.

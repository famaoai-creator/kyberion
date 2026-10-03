---
category: Fixed
---

- **Owned writes are placed by the owner's record, not the caller's guess** — new `resolveOwnerScope` / `resolveMissionDir` (`libs/core/owner-scope.ts`) derive tier, tenant and organization from the mission state, project record or organization directory; a caller tier/tenant can only narrow, and contradictions fail with `OwnerScopeError` (`[CODE] what — why | next: remedy`). Mission lookup no longer depends on `KYBERION_TENANT`, while a tenant-bound identity still never sees another tenant's owner. Scoped artifacts, mission → project links, project operational state and the orchestration / task-event / journal mission directories use it, so confidential and tenant missions no longer write into the public mission tree. The artifact ownership registry is queried as its latest row per artifact (superseded rows no longer match their old owner) and the storage janitor compacts it.

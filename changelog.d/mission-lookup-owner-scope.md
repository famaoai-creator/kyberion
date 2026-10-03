---
category: Fixed
---

- **Mission lookup and steering follow the mission's own record** — `findMissionPath` / `loadState` now resolve an existing mission through `resolveOwnerScope`, so tenant-partitioned missions are found without `KYBERION_TENANT`, a tenant-bound process never reads a flat directory holding another tenant's state, and an id present in several tenants fails with `OWNER_AMBIGUOUS` instead of returning the first match. Steering input for a mission that does not exist is refused with `OWNER_NOT_FOUND` instead of being queued where the mission would never read it.

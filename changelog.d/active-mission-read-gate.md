---
category: Security
---

- **Active mission dirs join the io-layer tenant boundary for reads** — `validateReadPermission` now treats `active/missions/<personal|confidential>` as protected paths, so a tenant-bound process reading another tenant's active mission content denies `tenant.scope_violation` instead of relying on owner-scope/app checks alone. The persona tier block stays archive-only, preserving own-tenant, unbound, untenanted, and public-tier read behavior. Bound mission lookup/enumeration (`findMissionPathAtRoot`, `listMissionsInSearchDirs`, owner-scope `missionCandidates`) probes the caller's own tenant partition instead of enumerating the protected tier root, and the mission-location cache keys by the bound tenant so a narrowed view cannot leak across scope changes.

---
category: Fixed
---

- **Golden gate no longer drifts on live checkouts** — `system:list_missions`, `watch_tenant_drift` and `virtual_office` enumerated protected mission tier roots directly; under a tenant-bound process that threw `scope_invalid_prefix` and failed `baseline-check`/`vital-check` golden comparisons wherever `active/missions/{confidential,personal}` exists. All three now probe via `missionTierScanDirs` and descend `<tier>/<tenant>/<id>` partitions instead of reporting tenant dirs as missions.

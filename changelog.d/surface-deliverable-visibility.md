---
category: Fixed
---

- **Mission deliverable visibility on surfaces** — tenant-bound missions are reachable through `mission-asset ?missionId=` and untenanted public artifacts now list/download for scoped viewers at public tier. Published records survive mission finish: `report`/`export` deliverables are promoted to the tenant or system artifact floor before archive instead of dangling as missing. Completion inbox entries carry `tenant_slug` (visible to tenant-scoped outcome feeds) and repo-relative artifact paths. Runtime-session `artifacts/` files are servable through mission-asset.

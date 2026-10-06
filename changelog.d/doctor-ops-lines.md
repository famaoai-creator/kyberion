---
category: Fixed
---

- **`pnpm run doctor` reports janitor and mesh state accurately.** The maintenance line now reads `janitor fresh` after a completed run instead of staying `pending` for 24 hours after the baseline check submitted it. Without `KYBERION_TENANT`, the mesh line says inspection was skipped and how to enable it, instead of showing the raw `mesh_inspection_invalid_tenant_id:` error.

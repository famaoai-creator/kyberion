---
category: Removed
---

- Removed the `@agent/core/ingest-quota` and `@agent/core/ingest-sync-cursors` subpaths: the per-tenant daily ingest budget and the sync watermark store are implementation details of the ingest actuator, so they now live inside `libs/actuators/ingest-actuator/src/` next to their only consumers. `@agent/core/ingest-tier-gate` and `@agent/core/ingest-asset-ledger` remain in core.

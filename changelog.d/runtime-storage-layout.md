---
category: Added
---

- **Runtime storage layout** — runtime data now has one governed place per purpose instead of defaulting to `active/shared/tmp/`: scratch (`tmp/`), inbound files (`staging/`, 3-day TTL), re-generable data (`cache/`, 30-day TTL), worker directories (`runtime/workspaces/`), deliverables (`writeScopedArtifact`), and durable state (`runtime/`). The shared floors partition as `system/` or `<tier>/<tenant|shared>/` (`@agent/core/storage-layout`); personal/confidential partitions are read-gated by tier-guard and tenant-isolated via `tenant_scope.protected_prefixes`. See `knowledge/product/architecture/runtime-storage-layout.md`.
- **Scoped artifacts reach surfaces** — `writeScopedArtifact` gains a `system` scope and a `publish` option that registers an ArtifactRecord, so deliverables appear in the Chronos deliverable inbox and preview through `mission-asset`. Tenant-scoped artifacts move from `active/projects/<tier>/<tenant>/artifacts/` to `active/shared/artifacts/<tier>/<tenant>/` (no production caller used the old location).

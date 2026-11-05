---
category: Changed
---

- **Video runtime moved to `@agent/shared-video`** — video ingest, composition compile/render, filters and recut moved out of `@agent/core` into the new `libs/shared-video` package. Update imports from `@agent/core/video/<module>` (and `@agent/core/video/ingest`) to `@agent/shared-video/<module>` (and `@agent/shared-video/ingest`). The video contracts, design system and frame plumbing stay at `@agent/core/video/*`. `tenantOfPath` / `tierOfPath` for scope checks now live in `@agent/core/path-tenant-attribution`. Lint rejects any `@agent/core` import of `@agent/shared-*`.

---
category: Changed
---

- **Video runtime moved to `@agent/shared-video`** — video ingest, composition compile/render, filters and recut moved out of `@agent/core` into the new `libs/shared-video` package. Update imports from `@agent/core/video/<module>` (and `@agent/core/video/ingest`) to `@agent/shared-video/<module>` (and `@agent/shared-video/ingest`). The video contracts, design system and frame plumbing stay at `@agent/core/video/*`. `tenantOfPath` / `tierOfPath` for scope checks now live in `@agent/core/path-tenant-attribution`. Lint rejects any `@agent/core` import of `@agent/shared-*`.
- **Media production runtime moved to `@agent/shared-media`** — the native docx/xlsx/pptx/pdf generation engines, image/music/video generation bridges and providers, and the media layout/drawio policies moved from `@agent/core/media/*` to `@agent/shared-media/*` (same relative module paths). Readers and parsers that core itself uses (document reader, docx/xlsx/pptx utils, pdf parser, image description) stay at `@agent/core/media/*`.

---
category: Changed
---

- Move Set-of-Marks session bookkeeping and target resolution from
  `@agent/core/mark-target-resolver` to `@agent/shared-perception/mark-target-resolver`.
  Vision, browser, and system consumers use the new package subpath. Mark freshness,
  mission-scoped storage, coordinate conversion, and canonical core security helpers
  are unchanged.

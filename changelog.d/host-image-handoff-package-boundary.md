---
category: Changed
---

- Move host image hand-off bookkeeping from `@agent/core/host-image-handoff`
  to `@agent/shared-media/host-image-handoff`, beside its image generation
  callers. Update any direct imports to the shared-media subpath.
- Preserve request markers, content-hash comparisons, idempotent collection,
  and all six existing regression tests. Shared-tmp classification and core
  persistence/security helpers remain unchanged.
- Transfer one export from core to shared-media and cover shared-media outputs
  in the existing CI workspace build contract without changing artifact scope.

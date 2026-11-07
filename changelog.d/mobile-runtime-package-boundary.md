---
category: Changed
---

- Move the shared Android/iOS runtime helpers from `@agent/core/mobile-runtime-helpers`
  to the existing `@agent/shared-mobile` package-root API and update both actuator
  callers. Preserve runtime behavior and existing shared-mobile deep imports.
- Keep profile validation, profile types, and secure I/O in core. Add isolated
  helper regression tests and cover mobile package outputs in the CI build contract.
- Reduce the core export-surface budget by one, on top of the preceding voice
  helper extraction. No scope, authority, store, or migration semantics change.

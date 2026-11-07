---
category: Changed
---

- Moved the two-stage voice interruption runtime to
  `@agent/shared-voice/two-stage-barge-in`, alongside its only runtime caller.
  The core v2 extraction removes `@agent/core/two-stage-barge-in`; update any
  direct imports to the shared-voice subpath. Timing, word counting, echo
  handling and interruption decisions are unchanged. The energy detector
  remains at `@agent/core/barge-in-controller` for meeting and voice callers.

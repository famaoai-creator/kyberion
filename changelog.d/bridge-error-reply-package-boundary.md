---
category: Changed
---

- Move the shared bridge error-reply helpers from
  `@agent/core/bridge-error-reply` to
  `@agent/shared-interaction/bridge-error-reply`, beside the other
  modality-independent conversation modules. The Discord, Slack, Telegram,
  and iMessage satellites now import the surface from `@agent/shared-interaction`.
- Keep error classification, UX vocabulary, rate limiting, and runtime
  control policy in core — only the presentation helpers moved.
- Transfer one export from core to shared-interaction and cover the move in
  the existing CI workspace build contract without changing artifact scope.

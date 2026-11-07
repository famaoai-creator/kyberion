---
category: Changed
---

- Move the governed agent-desktop AX bridge from `@agent/core/desktop-ax-bridge`
  to `@agent/shared-perception/desktop-ax-bridge`, beside its system-actuator
  accessibility consumer. Update any direct imports to the shared-perception
  subpath.
- Preserve the allowlisted subcommand surface, per-session namespacing, and the
  governed runtime-floor redirection; path resolution, scoped I/O, and managed
  tool binary resolution remain in core.
- Transfer one export from core to shared-perception and cover the move in the
  existing CI workspace build contract without changing artifact scope.

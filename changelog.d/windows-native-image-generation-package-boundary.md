---
category: Changed
---

- Move the Windows native image generation bridge from
  `@agent/core/windows-native-image-generation-bridge` to
  `@agent/shared-media/windows-native-image-generation-bridge`, beside the
  shared-media image-generation provider registry that is its only consumer.
  Update any direct imports to the shared-media subpath.
- Keep helper discovery through the governed environment registry and helper
  execution through `safeExecResult` in core — only the bridge boundary moved.
- Transfer one export from core to shared-media and cover the move in the
  existing CI workspace build contract without changing artifact scope.

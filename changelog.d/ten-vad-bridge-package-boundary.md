---
category: Changed
---

- Move the optional TEN VAD bridge from `@agent/core/ten-vad-bridge` to
  `@agent/shared-voice/ten-vad-bridge`, beside the other voice runtime
  installers. Voice-conversation and meeting scripts now import the bridge
  from `@agent/shared-voice`.
- Keep the VAD registry, bridge protocol, and activity-detector contract in
  core — `installTenVadBackend` still registers into the shared registry, so
  backend selection is unchanged.
- Transfer one export from core to shared-voice and cover the move in the
  existing CI workspace build contract without changing artifact scope.

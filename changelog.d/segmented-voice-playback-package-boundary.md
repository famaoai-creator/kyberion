---
category: Changed
---

- Move segmented voice playback from `@agent/core/segmented-voice-playback`
  to `@agent/shared-voice/segmented-voice-playback`, beside the realtime
  voice loop that is its only consumer. Update any direct imports to the
  shared-voice subpath.
- Keep audio playback, text chunking, and the streaming pause gate in core —
  the segmenter still consumes the same public subpaths.
- Transfer one export from core to shared-voice and cover the move in the
  existing CI workspace build contract without changing artifact scope.

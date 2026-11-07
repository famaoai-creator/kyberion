---
category: Changed
---

- Moved the Silero VAD backend bridge from `@agent/core/silero-vad-bridge` into `@agent/shared-voice/silero-vad-bridge`, beside the TEN backend; the VAD registry, bridge protocol, and activity-detector contracts stay in core, and voice scripts plus the system-actuator probe now import through the shared-voice subpath.

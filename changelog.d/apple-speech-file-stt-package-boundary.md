---
category: Changed
---

- Moved the Apple Speech file transcription backend from `@agent/core/apple-speech-file-stt-bridge` into `@agent/shared-voice/apple-speech-file-stt-bridge`, beside the VAD backends; the STT seam contract, local backend discovery, and locale/env/secure-exec plumbing stay in core, and voice scripts now import through the shared-voice subpath.

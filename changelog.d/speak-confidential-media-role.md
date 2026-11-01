---
category: Fixed
---

- **`kyberion speak --out` under confidential scope** — file TTS now assumes the same `perception_media_worker` role as `listen` / `watch` / `see`, so local engines can validate and copy audio written to tenant scratch instead of failing as "invalid audio artifact". `--out` must stay on a floor that does not lower the active scope tier (for example `active/shared/tmp/confidential/<tenant>/…`).

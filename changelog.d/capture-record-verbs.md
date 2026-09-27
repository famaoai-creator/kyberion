---
category: Added
---

- **`pnpm kyberion capture` / `pnpm kyberion record screen|audio|camera`** —
  the "take a photo / record" counterparts of `see` / `watch` / `listen`
  (which stay file-only). Stills go through `system:screenshot`
  (`--screen`, `--window`) and `system:capture_photo` (`--camera`); recordings
  through `system:record_screen`, `system:record_audio` (microphone, `--device`
  selectable), and `system:record_camera` (photo-per-frame, low fps by
  construction, max 60 s). Screen captures pass frame redaction; outputs stay
  in governed stores (`runtime/computer/*/`, shared `tmp/`); mic/camera run
  only on explicit invocation. Registered as `operator-cli.capture` and the
  two-word `record screen|audio|camera` commands so the existing bare `record`
  (operator-home desktop demonstration recorder) keeps working.

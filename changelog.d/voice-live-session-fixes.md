---
category: Fixed
---

- **Media events no longer spam session_id mismatch warnings** — the voice loop now uses the conversation session id, so `assistant_text_delta`/`transcript`/`audio_output` events land in the media buffer.
- **A single STT failure no longer ends the session** — a backend error (e.g. empty transcript on a noise blip) degrades that turn instead of killing the whole conversation.

---

- **STT backend warmup** — the first transcription pays a heavy model-load cost (~99s observed on first batch call); a short synthesized clip is now transcribed during VAD calibration so the first real turn stays fast.

---
category: Added
---

- **Apple native capabilities** — add version-gated capability discovery, multimodal and dynamic-session helpers, and governed screen/Shortcuts operations. Shortcut execution requires a tenant-bound, expiring human approval consumed before launch.
- **On-device OCR and speech readiness** — reuse cached Apple Vision OCR with confidence and privacy-mask geometry, preserve language and timeout budgets, and discover SpeechAnalyzer assets independently of the text model. Japanese/English speech assets must be installed before that recognizer is selected.
- **Perception safety** — retain source tier and tenant on image preparation and screen crops. Experimental Apple image captions remain explicit opt-in after real UI quality checks; existing detailed-vision defaults are preserved.

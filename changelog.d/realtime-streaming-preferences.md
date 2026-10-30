---
category: Fixed
---

- Resolve saved streaming voice commands per invocation without changing process environment or batch STT settings; honor explicit environment overrides and the canonical TTS sample-rate setting.
- Show streaming configuration, persist TTS argv, validate executable/argument values before saving, and support individually unsetting streaming defaults with validated dry-run previews.

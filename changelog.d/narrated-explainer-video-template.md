---
category: Added
---

- **Narrated explainer video template** — `knowledge/product/pipeline-templates/narrated-explainer-video.json` captures the validated Japanese HyperFrames flow (script → pronunciation lint → governed Kokoro voice → whisper round-trip → subtitle sync → check → preview → render). The production rules are documented in `knowledge/product/orchestration/japanese-voiceover-production-playbook.md` and the Kokoro backend is registered as `voice.mlx_audio_kokoro` in the media-backends registry. `hyperframes` devDependency bumped to ^0.8.147 for `remove-background` support.

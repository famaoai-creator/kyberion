---
category: Added
---

- **Template motion now appears in rendered videos.** Each scene's HyperFrames seek handler used to only log, so CSS motion never reached the frames. It now moves the scene's CSS animations to the requested time.
- **Authored, narration-timed videos.** `video-composition:create_timeline_video` takes scenes written as HTML (`timeline-html` template) plus one narration clip per scene. It sizes each scene from its measured narration, mixes the clips onto one track, and renders through HyperFrames. Scenes can use cue classes timed to the narration (`kb-cue` with `--at` / `--f`), a typewriter (`data-type`), count-ups (`data-count`) and assets (`{{asset:id}}`). See `knowledge/product/orchestration/timeline-video-authoring-playbook.md`.

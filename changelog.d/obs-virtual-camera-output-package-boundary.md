---
category: Changed
---

- Moved the OBS virtual-camera output backend from `@agent/core/obs-virtual-camera-output` into `@agent/shared-video/obs-virtual-camera-output`, beside its OBS video filter provider; the camera-output seam contract, env registry, and video-route types stay in core, and voice-actuator consumers now import through the shared-video subpath.

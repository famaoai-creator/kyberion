---
category: Changed
---

- Moved the v4l2 virtual-camera output adapter from `@agent/core/v4l2-virtual-camera-output` into `@agent/shared-video/v4l2-virtual-camera-output`, beside the OBS backend; the camera-output seam contract, the governed virtual-camera-injection bridge it wraps, and the device-lease manager stay in core, and the voice-actuator installer now imports through the shared-video subpath.

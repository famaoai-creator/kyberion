---
category: Added
---

- **Interactive iOS actuator ops** — ios-actuator gains `describe_ui`, `tap`, `tap_ui_node`, `swipe`, `input_text`, and `press_button` via AXe (SimulatorKit HID, iOS 26-safe), with an `axe` availability report in `simctl_health_check` and a precondition error naming `brew install cameroncooke/axe/axe` when the tool is absent. `capture_screen` prefers AXe so simulators on volumes the CoreSimulator service cannot write to still produce screenshots.
- **Live mirror for mobile devices** — new `libs/shared-mobile` provides `start_screen_stream`/`stop_screen_stream`/`stream_status` on both ios-actuator and android-actuator: a detached daemon serves a loopback MJPEG stream plus a click-to-tap viewer page, so a human can watch and touch the app while the agent works. Frame capture and input injection sit behind `FrameSource`/`InputInjector` interfaces for future SimulatorKit-grade sources.
- **Cross-platform UI-tree parity** — android-actuator `describe_ui` normalizes uiautomator XML into the same flat node list shape as the iOS AXe path.

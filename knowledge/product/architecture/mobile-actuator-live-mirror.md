---
title: 'Mobile Actuator Live Mirror — interactive device streaming (MSN-MOBILE-ACT-20261028)'
kind: evergreen
last_updated: 2026-10-28
---

# Mobile Actuator Live Mirror

## Goal

Give both mobile actuators the two capabilities the 2026 ecosystem already
has: (a) an agent-driven observe→act loop on iOS (it previously could only
launch and observe) and (b) a browser-embeddable live mirror of the device
screen so a human can watch — and click into — the app while an agent works.

## Design

Hybrid, per the mission decision:

- `libs/shared-mobile` (new) owns the device-agnostic layer:
  - `FrameSource` — one still frame per call. `SimctlScreenshotSource`
    (AXe-first, simctl fallback) and `AdbScreencapSource`
    (`adb exec-out screencap`). Deliberately one-shot execs so a
    SimulatorKit-grade streaming source can replace them without touching op
    contracts or the mirror.
  - `InputInjector` — `tap`/`swipe`/`inputText`/`pressButton`.
    `AxeInjector` wraps AXe (cameroncooke/AXe, SimulatorKit HID, iOS 26-safe);
    `AdbInjector` wraps `adb shell input`. Missing AXe surfaces a precondition
    error with the `brew install cameroncooke/axe/axe` hint, and
    `simctl_health_check` reports `axe` availability.
  - `MirrorServer` — loopback-only HTTP: `GET /` viewer HTML,
    `GET /stream.mjpeg` multipart/x-mixed-replace, `POST /tap {x,y}` →
    injector, `GET /status`. No durable stores; sessions are ephemeral.
  - `mirror-daemon.js` + `mirror-session.ts` — actuator CLI calls are
    short-lived, so `start_screen_stream` spawns the daemon detached via
    `spawnManagedProcess`; sibling ops coordinate through its state file +
    SIGTERM.

## Ops added

- ios-actuator: `describe_ui` (capture), `tap`, `tap_ui_node`, `swipe`,
  `input_text`, `press_button`, `start_screen_stream`, `stop_screen_stream`,
  `stream_status` (apply). `capture_screen` now tries AXe first.
- android-actuator: `describe_ui` (capture — normalizes uiautomator XML to a
  flat node list, matching the iOS AXe path's shape), `start_screen_stream`,
  `stop_screen_stream`, `stream_status` (apply).

## Why AXe and not XcodeBuildMCP

XcodeBuildMCP itself delegates simulator UI input to AXe, so wrapping AXe
directly is the shortest governed path. The `InputInjector`/`FrameSource`
interfaces are the replacement seam if a full MCP bridge is wanted later.

## Gotchas recorded

- `simctl io screenshot` is executed by the CoreSimulator service, which is
  sandboxed to OS temp dirs — it EPERMs writing into `/Volumes/data`
  checkouts. AXe `screenshot` runs in-process and writes into the repo fine;
  `capture_screen` and the iOS frame source try AXe first.
- AXe `describe-ui` fails while SpringBoard is still rendering right after
  boot — the capture/apply ops wrap it in the actuator retry policy.
- AXe labels live under `AXLabel`/`AXValue`/`title` keys (not `label`), and
  matching must prefer the smallest frame: containers share labels with leaf
  controls and their centers are wrong tap targets.

## Verification (this host)

iPhone 17 Pro (iOS 26) simulator: boot → `describe_ui` (490-node tree) →
`tap_ui_node {text:設定}` opened Settings → `capture_screen` wrote into
`active/shared/tmp/` → `start_screen_stream` served MJPEG at ~3fps with
click-to-tap (`POST /tap` opened Settings from the mirror). Android ops are
unit-tested with a stubbed frame source/injector (no adb device on host).

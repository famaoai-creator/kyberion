---
title: Replace Physical-Bridge With ADF
category: Orchestration
tags: [orchestration, browser, system, adf, cleanup]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-23
---

# Replace Physical-Bridge With ADF

`physical-bridge` is a legacy wrapper. It used to accept KUCA-style actions, write temporary JSON files, and shell back into other actuators through `cli.js`.

That pattern is no longer preferred. The modern Kyberion contract is:

- browser interactions go directly to `browser-actuator`
- desktop / keyboard / voice interactions go directly to `system-actuator`
- capture / generation flows go directly to `media-generation-actuator`
- multi-step coordination is expressed as a pipeline, not as a wrapper script

## Migration Mapping

- `click`, `double_click`, `scroll`, `browser_type`
  - move to `browser-actuator`
- `system_mouse_click`, `system_keypress`, `voice_output`
  - move to `system-actuator`
- `camera_capture`
  - move to `media-generation-actuator` or another dedicated capture surface
- `auto_observe`
  - replace with explicit `browser:snapshot` or `browser:screenshot`

## Replacement Pattern

Use a pipeline that targets the real actuators directly.

Reference example:

- [`physical-browser-system-sequence.json`](../../governance/pipelines/physical-browser-system-sequence.json)

This keeps execution explicit, avoids temporary wrapper artifacts, and preserves actuator ownership boundaries.

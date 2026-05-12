---
title: UI-TARS Desktop Clean-Room Notes
kind: notes
scope: repository
authority: reference
tags: [ui-tars, desktop, browser-automation, mcp, telemetry, permissions]
---

# UI-TARS Desktop Clean-Room Notes

Source repository reviewed: `bytedance/UI-TARS-desktop`

This note records implementation ideas in original Kyberion wording only.

## High-value concepts to reuse

- A clear split between local operator execution and remote operator execution.
- A GUI agent loop that alternates between screenshot capture, model prediction, and execution.
- A browser operator that can work through visual grounding, DOM-based actions, or a hybrid strategy.
- Explicit runtime retry budgets for model calls, screenshots, and execution steps.
- Permission preflight for desktop automation, especially accessibility and screen recording.
- Settings-driven model/provider selection with OpenAI-compatible base URL expectations.
- A telemetry-style event stream for launch, instruction intake, and artifact sharing.
- A separate report sharing path that uploads generated artifacts when configured.
- A preset import workflow for loading configuration bundles from files or URLs.

## Kyberion fit

- `browser-actuator`
  - Use the hybrid browser strategy as an implementation reference for visual fallback and DOM fallback.
  - The clickable-element highlight and screenshot feedback loop are especially relevant.
- `system-actuator`
  - Use the permission preflight pattern as a reference for desktop capability checks.
- `presence-actuator` and `meeting-browser-driver`
  - The local/remote operator split is useful for resilient surface routing.
- `media-actuator` and `service-actuator`
  - The settings-driven provider selection pattern maps well to preset-based execution.
- `knowledge/public/orchestration`
  - The event stream / report upload / preset import ideas can become governed operation notes.

## Security and governance notes

- Desktop permission prompts should be explicit and fail closed.
- External report storage should be treated as an authenticated boundary in Kyberion, even if the source example is open.
- Remote operator modes need explicit trust and network boundary documentation before rollout.

## Avoid copying

- Product naming and marketing wording.
- Exact config examples and prose from the source docs.
- Any implementation text that is not a clean-room restatement.


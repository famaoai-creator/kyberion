---
title: Media Execution Backend Abstraction
category: Architecture
tags: [media, image, voice, video, registry, adapter, governance]
importance: 7
last_updated: 2026-05-31
---

# Media Execution Backend Abstraction

Kyberion treats image, voice, music, and video as separate modalities, but they share the same governing flow:

`intent -> brief -> modality contract -> backend registry -> adapter execution -> artifact`

## What Is Shared

- the upstream intent and content brief
- the execution contract that describes what should be produced
- a backend registry that says which execution backend is allowed
- deterministic artifact handling and evidence capture

## What Is Modal-Specific

- image generation can resolve to API or CLI-backed service presets
- image generation can also resolve to macOS native Image Playground via `media-generation.apple_playground`, then Apple Silicon local FLUX via `mflux` when `local_flux` is available
- voice generation can resolve to local TTS or clone-capable engines
- video rendering can resolve to HyperFrames/ffmpeg-style render backends

## Current Runtime Shape

- `image-generation-adf` is compiled and handed to the `media-generation` service preset
- `voice-actuator` resolves the selected voice engine and normalizes it to backend metadata
- `video-render-backend` resolves the render backend and records backend metadata with the render result

## Governing Registry

The shared registry lives at:

- [`knowledge/product/governance/media-backend-registry.json`](/Users/famao/kyberion/knowledge/product/governance/media-backend-registry.json)

It provides a small, governed list of backends for:

- `image`
- `voice`
- `video`
- `music`

For local FLUX image generation, use the governed image backend `media-generation.local_flux` and the environment policy defined in `libs/core/image-generation-policy.ts`:

- `KYBERION_MFLUX_PACKAGE`
- `KYBERION_MFLUX_MODEL`
- `KYBERION_MFLUX_STEPS`
- `KYBERION_MFLUX_QUANTIZE`
- `KYBERION_MFLUX_TIMEOUT_MS`

For macOS native Image Playground generation, use `media-generation.apple_playground`.
The native bridge probes Image Playground separately from Foundation Models and
returns a PNG artifact; when the image model is not enabled, the governed
provider preference falls back to `local_flux` and then ComfyUI.

The backend launch command itself is now resolved through the governed tool runtime abstraction:

- `libs/core/tool-runtime-policy.ts`
- `libs/core/tool-runtime-registry.ts`
- `knowledge/product/governance/tool-runtime-policy.json`
- `knowledge/product/governance/tool-runtime-registry.json`

For long-lived services such as ComfyUI, the same idea applies one layer up via the service runtime abstraction:

- `libs/core/service-runtime-policy.ts`
- `libs/core/service-runtime-registry.ts`
- `knowledge/product/governance/service-runtime-policy.json`
- `knowledge/product/governance/service-runtime-registry.json`

## Design Rule

Do not encode backend selection directly in the user intent.
Keep the intent focused on the desired artifact, and let the registry and adapter layer decide whether the task should run via API, CLI, local engine, or deterministic render backend.

This keeps the user-facing intent stable while allowing backend implementations to change without reworking the whole flow.

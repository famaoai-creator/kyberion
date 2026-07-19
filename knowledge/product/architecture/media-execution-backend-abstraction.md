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

- media-generation requests now follow one governed boundary:
  `request validation -> design/style resolution -> modality compilation -> backend resolution -> execution/submission -> job transition -> artifact collection -> trace/evidence`
- direct image requests and ADF/workflow requests both pass through request normalization and style-pack injection before execution
- `image-generation-adf` is compiled and handed to the `media-generation` service preset
- `video-generation-adf` and `music-generation-adf` resolve ComfyUI through modality-specific contracts (`media-generation.comfyui.video` / `.music`); `media-generation.comfyui` remains the image compatibility alias
- persisted jobs keep `backend_id`, `backend_kind`, `backend_provider`, and generic `provider_job_id`; `prompt_id` is retained as a compatibility field
- client wait timeout is an observation result (`wait_status: timed_out`) and does not turn the persisted provider job into a terminal state
- `voice-actuator` resolves the selected voice engine and normalizes it to backend metadata
- `video-render-backend` resolves the render backend and records backend metadata with the render result

Generation jobs use explicit transitions: `submitted -> running -> succeeded|failed|canceled`, `failed -> retrying -> submitted`, and no transition out of terminal success/cancel states. Artifact collection must find an existing, modality-compatible output before success is recorded.

Screen capture and recording remain compatibility actions, but their implementation is isolated from generation job handling. `capture_screen`, `capture_focused_window`, and `record_screen` forward to canonical system-actuator operations. Canonical recording uses the secure screen-recording bridge on `darwin` / `linux`; the legacy macOS `avfoundation` service preset is no longer the media compatibility implementation. Backend availability uses one media registry probe contract backed by the governed service runtime, tool runtime, or native Image Playground bridge. Probe results are bounded-cache entries with `probe_id`, timestamps, cache expiry, and cache-hit metadata; failed probes are evicted so a later request can retry. Provider-specific HTTP access is isolated behind a provider history-client resolver and secure ComfyUI client. A job owned by a provider without a registered history client remains refreshable and reports an explicit unsupported-provider status; it is never silently queried through ComfyUI. History/artifact extraction uses modality-specific adapters so image, video, music, and generic workflow outputs cannot silently cross modality boundaries.

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

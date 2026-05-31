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
- voice generation can resolve to local TTS or clone-capable engines
- video rendering can resolve to HyperFrames/ffmpeg-style render backends

## Current Runtime Shape

- `image-generation-adf` is compiled and handed to the `media-generation` service preset
- `voice-actuator` resolves the selected voice engine and normalizes it to backend metadata
- `video-render-backend` resolves the render backend and records backend metadata with the render result

## Governing Registry

The shared registry lives at:

- [`knowledge/public/governance/media-backend-registry.json`](/Users/famao/kyberion/knowledge/public/governance/media-backend-registry.json)

It provides a small, governed list of backends for:

- `image`
- `voice`
- `video`
- `music`

## Design Rule

Do not encode backend selection directly in the user intent.
Keep the intent focused on the desired artifact, and let the registry and adapter layer decide whether the task should run via API, CLI, local engine, or deterministic render backend.

This keeps the user-facing intent stable while allowing backend implementations to change without reworking the whole flow.

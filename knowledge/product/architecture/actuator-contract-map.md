---
title: Actuator Contract Map
category: Architecture
tags: [architecture, actuators, contracts, schemas, ux]
importance: 9
author: Ecosystem Architect
last_updated: 2026-06-03
---

# Actuator Contract Map

This document is the shortest practical map of the current actuator contract model.

Use it when you want to answer:

- which actuator should I call
- whether it is `pipeline`-driven or action-driven
- which schema defines the real contract
- where the remaining conceptual rough edges still are

Read this together with:

- [`actuator-op-taxonomy.md`](actuator-op-taxonomy.md)
- [`global_actuator_index.json`](knowledge/product/orchestration/global_actuator_index.json)

## Reading Rule

The current discovery model is:

1. find an actuator in the index or CLI
2. read its `manifest.json`
3. follow `contract_schema`
4. read the detailed step or action vocabulary there

Discovery order should follow [`actuator-discovery-registry.md`](../orchestration/actuator-discovery-registry.md):

1. `global_actuator_index.json` order
2. manifest-backed package order
3. lexical fallback only when no catalog signal exists

This means `manifest.json` is the index.
The schema is the real detailed contract.

## Current Map

| Actuator | Shape | Canonical entry | Contract schema | Notes |
| --- | --- | --- | --- | --- |
| `agent-actuator` | action | `spawn`, `ask`, `list`, `health`, `a2a`, `team_plan` | `schemas/agent-action.schema.json` | Agent lifecycle and delegation |
| `android-actuator` | pipeline | `pipeline` | `schemas/mobile-device-pipeline.schema.json` | Shared mobile pipeline schema |
| `approval-actuator` | action | `create`, `load`, `decide`, `list_pending` | `schemas/approval-action.schema.json` | Approval transport; secret mutation requests should use `schemas/secret-mutation-approval.schema.json` as the canonical payload contract |
| `artifact-actuator` | action | `write_json`, `read_json`, `append_event`, `write_delivery_pack` | `schemas/artifact-action.schema.json` | Governed runtime artifacts |
| `blockchain-actuator` | action | `anchor_mission`, `anchor_trust` | `schemas/blockchain-action.schema.json` | Anchoring facade |
| `browser-actuator` | pipeline + computer interaction | `pipeline`, `computer_interaction` | `schemas/browser-pipeline.schema.json`, `schemas/computer-interaction.schema.json` | Browser executor for ref/snapshot interaction loops |
| `code-actuator` | pipeline + control | `pipeline`, `reconcile` | `schemas/code-pipeline.schema.json` | Reconcile remains top-level control action |
| `file-actuator` | pipeline | `pipeline` | `schemas/file-pipeline.schema.json` | File step vocabulary is in schema |
| `ios-actuator` | pipeline | `pipeline` | `schemas/mobile-device-pipeline.schema.json` | Shared mobile pipeline schema |
| `media-actuator` | pipeline | `pipeline` | `schemas/media-pipeline.schema.json` | Broad transformation vocabulary; still historically wide |
| `media-generation-actuator` | action | generation and capture actions | `schemas/media-generation-action.schema.json` | Canonical home of generation/capture |
| `modeling-actuator` | pipeline + control | `pipeline`, `reconcile` | `schemas/modeling-pipeline.schema.json` | IR and semantic transform territory |
| `network-actuator` | pipeline | `pipeline` | `schemas/network-pipeline.schema.json` | Secure fetch and A2A transport |
| `orchestrator-actuator` | pipeline + control | `pipeline`, `reconcile` | `schemas/orchestrator-pipeline.schema.json` | Control-plane transformation layer |
| `presence-actuator` | action | `dispatch`, `receive_event` | `schemas/presence-action.schema.json` | Human-facing delivery bridge |
| `process-actuator` | action | `spawn`, `stop`, `list`, `status` | `schemas/process-action.schema.json` | Managed long-lived processes |
| `secret-actuator` | action | `get`, `set`, `delete` | `schemas/secret-action.schema.json` | OS native secret bridge; approval and workflow state live outside the actuator |
| `service-actuator` | hybrid | `pipeline` and direct service actions | `schemas/service-action.schema.json` | Most flexible contract; now explicitly modeled |
| `system-actuator` | pipeline + control + computer interaction | `pipeline`, `reconcile`, `computer_interaction` | `schemas/system-pipeline.schema.json`, `schemas/computer-interaction.schema.json` | OS control plane for diagnostics, focused-input, and system input bridge |
| `terminal-actuator` | action + computer interaction | `spawn`, `poll`, `write`, `kill`, `computer_interaction` | `schemas/terminal-action.schema.json`, `schemas/computer-interaction.schema.json` | PTY contract plus terminal session interaction loop |
| `vision-actuator` | action + compatibility | `inspect_image`, `ocr_image` | `schemas/vision-action.schema.json` | Perception-first, legacy routes still described in schema |
| `voice-actuator` | action + lightweight pipeline | `speak_local`, `list_voices`, `pipeline` | `schemas/voice-action.schema.json` | Mixed contract explicitly documented |
| `wisdom-actuator` | action | `knowledge_search`, `knowledge_inject`, `knowledge_export`, `knowledge_import` | `schemas/wisdom-action.schema.json` | Knowledge-tier operations |

## Cleanup View

The fastest way to think about the current catalog is by responsibility, not just by op name.

### A. Control-plane / policy-driven actuators

- `agent-actuator` - agent lifecycle and A2A routing
- `approval-actuator` - human approval gates
- `artifact-actuator` - governed deliverable packaging
- `code-actuator` - analysis and refactoring workflows
- `modeling-actuator` - semantic and architecture transforms
- `orchestrator-actuator` - execution-plan orchestration
- `presence-actuator` - human-facing messaging / status bridge
- `process-actuator` - managed runtime lifecycle
- `service-actuator` - external SaaS/API/MCP reachability gateway
- `system-actuator` - OS control plane for diagnostics, focused-input, and short-lived OS actions
- `wisdom-actuator` - knowledge search, injection, import/export, and decision support

These are the best candidates for knowledge-backed policy maps, because their behavior is already driven by catalogs, schemas, or governance rules.

### B. Boundary / environment actuators

- `android-actuator` - Android device boundary
- `browser-actuator` - browser boundary
- `calendar-actuator` - calendar boundary
- `email-actuator` - mail boundary
- `file-actuator` - file boundary
- `ios-actuator` - iOS simulator boundary
- `meeting-actuator` - meeting boundary
- `media-generation-actuator` - generative media boundary
- `network-actuator` - secure fetch / transport boundary
- `secret-actuator` - secret-store boundary
- `terminal-actuator` - PTY / shell boundary
- `video-composition-actuator` - deterministic video-assembly boundary
- `voice-actuator` - voice synthesis / voice-profile boundary
- `blockchain-actuator` - ledger anchoring boundary
- `vision-actuator` - visual perception boundary

These should stay close to code and platform primitives. Knowledge can still drive their routing, but the low-level execution boundary should remain explicit.

### C. Mixed / compatibility actuators

- `media-actuator` - document and asset generation; still mixes low-level rendering with higher-level document transforms
- `meeting-browser-driver` - implementation bridge behind the meeting surface
- `vision-actuator` - compatibility facade in addition to perception duties
- `service-actuator` - hybrid gateway with multiple access modes (`pipeline`, `api`, `cli`, `preset`, `mcp`, `oauth`)

These are the best cleanup candidates if the goal is to reduce overlap. They are not wrong, but they blur the boundary between canonical contract and compatibility surface.

### D. Practical sorting rule

When you continue the actuator cleanup, sort each actuator into one of these four buckets:

1. knowledge/policy-driven control-plane
2. physical boundary/runtime
3. mixed compatibility surface
4. legacy review / consolidation candidate

Then keep the manifest as the canonical public contract and move everything else into schemas, policy catalogs, or compatibility notes.

### E. Concrete consolidation candidates

| Actuator | Current shape | Concrete next move | Stop condition |
| --- | --- | --- | --- |
| `meeting-browser-driver` | Driver-level implementation bridge behind meeting join flows | Keep the package as the browser driver implementation for now, but treat `meeting-actuator` as the canonical public surface. Move any caller-facing language, routing, and selection policy into `meeting-actuator` or `knowledge/product/orchestration/service-presets/meeting.json`, and avoid exposing new public ops here. | When all direct callers go through `meeting-actuator` and the driver is only referenced as an internal join backend. |
| `vision-actuator` | Compatibility facade with only `inspect_image` / `ocr_image` | Freeze the public surface to perception-only ops. Any future generation, screenshot, or screen-recording behavior should continue to live in `media-generation-actuator`. If new perception ops appear, prefer a new perception boundary over expanding this facade. | When no caller depends on `vision-actuator` as a unique entry point and perception callers can be migrated or re-routed. |
| `media-actuator` | Broad renderer plus higher-level composition helpers | Keep the low-level render boundary (`pptx_render`, `docx_render`, `xlsx_render`, filtering, patching) in the actuator, but continue moving storyline, theme derivation, and content-merging policy into knowledge-backed composition catalogs or modeling/orchestration layers. | When the public op set is limited to rendering and patching primitives, with higher-level composition handled elsewhere. |
| `service-actuator` | Hybrid external SaaS/API/MCP gateway | Do not split the package. Instead, keep a single gateway surface and continue pushing per-service presets, auth policy, and connector routing into knowledge catalogs and `service-binding`. | When the gateway still needs multiple access modes (`pipeline`, `api`, `cli`, `preset`, `mcp`, `oauth`) and a single owner is operationally simpler. |

### F. Recommended priority order

1. `meeting-browser-driver` - easiest consolidation win because it is already a thin implementation bridge.
2. `vision-actuator` - keep as compatibility-only and prevent new surface growth.
3. `media-actuator` - highest benefit, but only after the render-vs-composition boundary is made explicit.
4. `service-actuator` - keep as a single gateway; optimize policy/callers, not package splitting.

## Streaming Boundary Model

When the repository talks about camera, microphone, virtual devices, or live
streaming, use these nouns consistently:

- `capture` - acquire raw input from the physical world or an OS device
- `perception` - interpret a captured artifact or stream
- `generation` - create a new artifact or stream
- `composition` - combine multiple governed outputs into one deliverable
- `bridge` - own the device-facing hookup and OS routing
- `bus` - transport bytes, frames, or PCM without adding meaning
- `coordinator` - choose the right bridge/bus/actuator and manage the session lifecycle

### Current ownership

| Boundary | Current owner | Notes |
| --- | --- | --- |
| `system` control plane | `system-actuator` | OS permissions, routing toggles, input switching, and media/input/display diagnostics live here. Do not move stream transport or semantic processing into it. |
| virtual device inventory bridge | `VirtualDeviceInventoryBridge` | Scans host-visible audio / camera devices and exposes candidate lists for bridge selection. |
| virtual input device inventory bridge | `VirtualInputDeviceInventoryBridge` | Scans host-visible keyboard / mouse / pointing devices and exposes candidate lists for OS automation and diagnostics. |
| screen display inventory bridge | `ScreenDisplayInventoryBridge` | Scans host-visible display candidates and exposes indices / names for screenshot and recording selection. |
| virtual audio input recording bridge | `VirtualAudioInputRecordingBridge` | Selects a host-visible microphone input and records a short sample for voice capture and verification. |
| virtual audio device bridge | `VirtualAudioDeviceBridge` | Owns bus selection, probe, and device hookup. Delegates PCM transport to `AudioBus`. |
| virtual audio output playback bridge | `VirtualAudioOutputPlaybackBridge` | Switches the macOS default output device temporarily and plays a short test tone or TTS artifact so each selected speaker can be verified through the bridge path. |
| screen capture bridge | `ScreenCaptureBridge` | Owns screenshot / focused-window capture and screen-frame piping into a video bus. Delegates stream transport and recording to downstream layers. |
| screen recording bridge | `ScreenRecordingBridge` | Owns the screen-frame to mp4 wrapper. It does not interpret the frames; it just packages a capture stream into archive form. |
| video frame bus | `VideoFrameBus` | Transports camera or screen frames without adding meaning. Bridges write frames into the bus; downstream consumers read them. |
| video frame archive | `VideoFrameArchive` helpers | Encodes a frame stream into mp4 or decodes mp4 back into frames. This is a format boundary, not a device boundary. |
| virtual camera bridge | `VirtualCameraBridge` | Owns camera backend selection, probe, photo capture, and camera-frame piping into a video bus. Delegates image transport and perception to downstream layers. |
| virtual camera injection bridge | `VirtualCameraInjectionBridge` | Accepts mp4 or frame streams and either replays them through the archive boundary or injects them into an OS-backed virtual camera sink when one exists. |
| virtual media device control bridge | `VirtualMediaDeviceControlBridge` | Exposes runtime selection for existing audio/camera devices and host provisioning plans for add/remove flows. |
| audio transport | `AudioBus`, `BlackHoleAudioBus`, `PulseAudioBus` | This is the transport layer for PCM streams. It is not the place for STT/TTS policy. |
| meeting session lifecycle | `meeting-actuator` | Owns join / leave / speak / listen / chat / status semantics. |
| meeting browser join backend | `meeting-browser-driver` | Internal browser join implementation behind the meeting surface; surfaced as the `join_backend` label in meeting bridge/status payloads. |
| voice synthesis / profile / sample workflows | `voice-actuator` | Keeps TTS, playback, voice profiles, and recording workflows. |
| image perception | `vision-actuator` | Keeps `inspect_image` and `ocr_image` only. |
| media generation | `media-generation-actuator` | Keeps image/video/music generation and screen-capture boundary paths. |
| document / asset composition | `media-actuator` | Keep the document/render primitives here and keep pushing higher-level composition policy into catalogs. |

### Practical rule

If a feature needs a virtual microphone or virtual camera, split it in this order:

1. the `bridge` owns the device hookup and OS routing
2. the `bus` moves the stream or frame sequence
3. the `coordinator` wires the session
4. the actuator above the stack handles only meaning or user-facing policy

For camera and screen upstream/downstream flows, the relevant bridge captures frames, the frame bus carries them, the archive boundary can package them into mp4, and the injection/recording bridges own the reverse path when an OS-backed sink exists.

That keeps `system-actuator` as the OS control plane without turning it into a stream transport layer.

## The Main Improvement

The repository is now much easier to read because the old ambiguity has been reduced:

- `manifest.json` no longer needs to carry every internal helper
- pipeline-based actuators expose `pipeline` as the top-level contract
- schemas now carry the detailed step vocabulary
- `cli info` shows the contract schema directly

That is a better fit for both humans and LLMs.

## Remaining Rough Edges

These areas are improved, but still not perfect.

- `media-actuator`
  - the vocabulary is still broad and mixes physical rendering with higher-level transformations
- `service-actuator`
  - now modeled clearly, but it still bundles several submodes into one actuator
- `vision-actuator`
  - still carries compatibility concerns while the conceptual home of generation is `media-generation-actuator`
- shared mobile schema
  - `android` and `ios` intentionally share one envelope, but their exact step sets are not identical

## Recommended Mental Model

Use this shortcut:

- if it touches files, browser, system, media, or network directly, expect a physical or pipeline contract
- if it manages missions, approvals, runtimes, or agents, expect a control/action contract
- if the manifest is too short, the schema is the next place to read, not the implementation

That is the intended current UX.

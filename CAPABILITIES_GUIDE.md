# Kyberion Capabilities Guide

Total Actuators: 27
Last updated: 2026-05-09

This guide is generated from `libs/actuators/*/manifest.json`. It is the human-readable counterpart to the compatibility snapshot `knowledge/public/orchestration/global_actuator_index.json`.

Legacy or conceptual capability names are intentionally excluded here. If a component is not manifest-backed, it is not part of the current runtime catalog.

| Actuator | Description | Version | Ops | Contract Schema | Path |
| :--- | :--- | :--- | :---: | :--- | :--- |
| `agent-actuator` | Meta-Actuator for Agent Lifecycle and A2A | 1.0.0 | 6 | `schemas/agent-action.schema.json` | `libs/actuators/agent-actuator` |
| `android-actuator` | ADB-driven Android Device Actuator | 1.0.0 | 1 | `schemas/mobile-device-pipeline.schema.json` | `libs/actuators/android-actuator` |
| `approval-actuator` | Human approval request state transitions and decision handling | 1.0.0 | 4 | `schemas/approval-action.schema.json` | `libs/actuators/approval-actuator` |
| `artifact-actuator` | Governed Artifact and Delivery Pack Manager | 1.0.0 | 4 | `schemas/artifact-action.schema.json` | `libs/actuators/artifact-actuator` |
| `blockchain-actuator` | Immutable Ledger Anchoring System | 1.0.0 | 2 | `schemas/blockchain-action.schema.json` | `libs/actuators/blockchain-actuator` |
| `browser-actuator` | Pipeline-driven Playwright browser execution and session artifact actuator | 1.0.0 | 2 | `schemas/browser-pipeline.schema.json` | `libs/actuators/browser-actuator` |
| `calendar-actuator` | macOS Calendar.app integration using JXA for cross-account schedule coordination | 1.0.0 | 3 | `schemas/calendar-action.schema.json` | `libs/actuators/calendar-actuator` |
| `code-actuator` | ADF-driven code analysis and refactoring pipeline engine | 2.1.0 | 2 | `schemas/code-pipeline.schema.json` | `libs/actuators/code-actuator` |
| `file-actuator` | Generic File-Actuator for Kyberion | 1.0.0 | 1 | `schemas/file-pipeline.schema.json` | `libs/actuators/file-actuator` |
| `ios-actuator` | simctl-driven iOS Simulator Actuator | 1.0.0 | 1 | `schemas/mobile-device-pipeline.schema.json` | `libs/actuators/ios-actuator` |
| `media-actuator` | Document and asset generation engine. Includes document_digest, pptx_slide_text, and pptx_filter_slides for template-inheriting partial-update workflows. | 1.1.0 | 1 | `schemas/media-pipeline.schema.json` | `libs/actuators/media-actuator` |
| `media-generation-actuator` | Generative image, video, music, and screen capture actuator | 1.1.0 | 10 | `schemas/media-generation-action.schema.json` | `libs/actuators/media-generation-actuator` |
| `meeting-actuator` | Abstracted online meeting bridge (Zoom, Teams, Google Meet) | 1.0.0 | 6 | `schemas/meeting-action.schema.json` | `libs/actuators/meeting-actuator` |
| `meeting-browser-driver` | Playwright MeetingJoinDriver for Meet (primary) + Zoom/Teams (selectors-as-config). Implements libs/core MeetingJoinDriver and writes captured audio to an AudioBus. | 1.0.0 | 2 | `-` | `libs/actuators/meeting-browser-driver` |
| `modeling-actuator` | Architectural Analysis and ADF Transformation Engine | 1.0.0 | 2 | `schemas/modeling-pipeline.schema.json` | `libs/actuators/modeling-actuator` |
| `network-actuator` | ADF-driven secure fetch and A2A transport pipeline engine | 2.2.0 | 1 | `schemas/network-pipeline.schema.json` | `libs/actuators/network-actuator` |
| `orchestrator-actuator` | Mission/control-plane transformation and execution-plan orchestration actuator | 1.0.0 | 2 | `schemas/orchestrator-pipeline.schema.json` | `libs/actuators/orchestrator-actuator` |
| `presence-actuator` | Human Presence and Messaging Bridge | 1.0.0 | 3 | `schemas/presence-action.schema.json` | `libs/actuators/presence-actuator` |
| `process-actuator` | Managed process lifecycle actuator backed by the runtime supervisor | 1.0.0 | 4 | `schemas/process-action.schema.json` | `libs/actuators/process-actuator` |
| `secret-actuator` | OS Native Secret Manager Bridge | 1.0.0 | 3 | `schemas/secret-action.schema.json` | `libs/actuators/secret-actuator` |
| `service-actuator` | Unified External SaaS/API Reachability Layer | 1.0.0 | 6 | `schemas/service-action.schema.json` | `libs/actuators/service-actuator` |
| `system-actuator` | OS-level control, diagnostics, and short-lived local execution | 1.1.0 | 3 | `schemas/system-pipeline.schema.json` | `libs/actuators/system-actuator` |
| `terminal-actuator` | PTY-driven Terminal Actuator | 1.0.0 | 5 | `schemas/terminal-action.schema.json` | `libs/actuators/terminal-actuator` |
| `video-composition-actuator` | Governed deterministic composed-video bundle preparation actuator | 1.0.0 | 6 | `-` | `libs/actuators/video-composition-actuator` |
| `vision-actuator` | Perception-oriented compatibility facade; generation and screen capture live in media-generation-actuator | 1.3.0 | 2 | `schemas/vision-action.schema.json` | `libs/actuators/vision-actuator` |
| `voice-actuator` | Governed local voice generation actuator with native playback and artifact fallback | 1.2.0 | 7 | `schemas/voice-action.schema.json` | `libs/actuators/voice-actuator` |
| `wisdom-actuator` | Knowledge-tier search, injection, import/export, and decision-support operations | 1.1.0 | 32 | `schemas/wisdom-action.schema.json` | `libs/actuators/wisdom-actuator` |

See also:

- Source manifests: `libs/actuators/*/manifest.json`
- Compatibility snapshot: [global_actuator_index.json](/Users/famao/kyberion/knowledge/public/orchestration/global_actuator_index.json)
- [legacy_component_index.json](/Users/famao/kyberion/knowledge/public/orchestration/legacy_component_index.json)
- [component-lifecycle-inventory.md](/Users/famao/kyberion/knowledge/public/architecture/component-lifecycle-inventory.md)


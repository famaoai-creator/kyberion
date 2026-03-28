# Kyberion Capabilities Guide

Total Actuators: 23
Last updated: 2026-03-24

This is the catalog of Kyberion's execution body.

Users should normally ask Kyberion for outcomes such as:

- `このPDFをパワポにして`
- `日経新聞を開いて`
- `今週の進捗レポートを作って`

Kyberion then chooses the appropriate actuators internally.

This guide is therefore an operator and contributor reference, not the primary end-user interface.

It is generated from manifest-backed actuators and is the human-readable counterpart to `knowledge/public/orchestration/global_actuator_index.json`.

Legacy or conceptual capability names are intentionally excluded here. If a component is not manifest-backed, it is not part of the current runtime catalog.

| Actuator | Description | Version | Ops | Contract Schema | Path |
| :--- | :--- | :--- | :---: | :--- | :--- |
| `agent-actuator` | Meta-Actuator for Agent Lifecycle and A2A | 1.0.0 | 6 | `schemas/agent-action.schema.json` | `libs/actuators/agent-actuator` |
| `android-actuator` | ADB-driven Android Device Actuator | 1.0.0 | 1 | `schemas/mobile-device-pipeline.schema.json` | `libs/actuators/android-actuator` |
| `approval-actuator` | Human approval request state transitions and decision handling | 1.0.0 | 4 | `schemas/approval-action.schema.json` | `libs/actuators/approval-actuator` |
| `artifact-actuator` | Governed Artifact and Delivery Pack Manager | 1.0.0 | 4 | `schemas/artifact-action.schema.json` | `libs/actuators/artifact-actuator` |
| `blockchain-actuator` | Immutable Ledger Anchoring System | 1.0.0 | 2 | `schemas/blockchain-action.schema.json` | `libs/actuators/blockchain-actuator` |
| `browser-actuator` | Pipeline-driven Playwright browser execution and session artifact actuator | 1.0.0 | 2 | `schemas/browser-pipeline.schema.json` | `libs/actuators/browser-actuator` |
| `code-actuator` | ADF-driven code analysis and refactoring pipeline engine | 2.1.0 | 2 | `schemas/code-pipeline.schema.json` | `libs/actuators/code-actuator` |
| `file-actuator` | Generic File-Actuator for Kyberion | 1.0.0 | 1 | `schemas/file-pipeline.schema.json` | `libs/actuators/file-actuator` |
| `ios-actuator` | simctl-driven iOS Simulator Actuator | 1.0.0 | 1 | `schemas/mobile-device-pipeline.schema.json` | `libs/actuators/ios-actuator` |
| `media-actuator` | Document and asset generation engine | 1.0.0 | 1 | `schemas/media-pipeline.schema.json` | `libs/actuators/media-actuator` |
| `media-generation-actuator` | Generative image, video, music, and screen capture actuator | 1.0.0 | 10 | `schemas/media-generation-action.schema.json` | `libs/actuators/media-generation-actuator` |
| `modeling-actuator` | Architectural Analysis and ADF Transformation Engine | 1.0.0 | 2 | `schemas/modeling-pipeline.schema.json` | `libs/actuators/modeling-actuator` |
| `network-actuator` | ADF-driven secure fetch and A2A transport pipeline engine | 2.2.0 | 1 | `schemas/network-pipeline.schema.json` | `libs/actuators/network-actuator` |
| `orchestrator-actuator` | Mission/control-plane transformation and execution-plan orchestration actuator | 1.0.0 | 2 | `schemas/orchestrator-pipeline.schema.json` | `libs/actuators/orchestrator-actuator` |
| `presence-actuator` | Human Presence and Messaging Bridge | 1.0.0 | 3 | `schemas/presence-action.schema.json` | `libs/actuators/presence-actuator` |
| `process-actuator` | Managed process lifecycle actuator backed by the runtime supervisor | 1.0.0 | 4 | `schemas/process-action.schema.json` | `libs/actuators/process-actuator` |
| `secret-actuator` | OS Native Secret Manager Bridge | 1.0.0 | 3 | `schemas/secret-action.schema.json` | `libs/actuators/secret-actuator` |
| `service-actuator` | Unified External SaaS/API Reachability Layer | 1.0.0 | 6 | `schemas/service-action.schema.json` | `libs/actuators/service-actuator` |
| `system-actuator` | OS-level control, diagnostics, and short-lived local execution | 1.0.0 | 3 | `schemas/system-pipeline.schema.json` | `libs/actuators/system-actuator` |
| `terminal-actuator` | PTY-driven Terminal Actuator | 1.0.0 | 5 | `schemas/terminal-action.schema.json` | `libs/actuators/terminal-actuator` |
| `vision-actuator` | Perception-oriented compatibility facade; generation and screen capture live in media-generation-actuator | 1.3.0 | 2 | `schemas/vision-action.schema.json` | `libs/actuators/vision-actuator` |
| `voice-actuator` | Local Generative TTS Actuator (Style-Bert-VITS2) | 1.0.0 | 2 | `schemas/voice-action.schema.json` | `libs/actuators/voice-actuator` |
| `wisdom-actuator` | Knowledge-tier search, injection, import, and export actuator | 1.0.0 | 4 | `schemas/wisdom-action.schema.json` | `libs/actuators/wisdom-actuator` |

See also:

- [global_actuator_index.json](knowledge/public/orchestration/global_actuator_index.json)
- [legacy_component_index.json](knowledge/public/orchestration/legacy_component_index.json)
- [component-lifecycle-inventory.md](knowledge/public/architecture/component-lifecycle-inventory.md)

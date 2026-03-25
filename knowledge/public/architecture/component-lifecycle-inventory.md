---
title: Component Lifecycle Inventory
category: Architecture
tags: [architecture, actuators, cleanup, governance]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-24
---

# Component Lifecycle Inventory

This inventory is generated from the filesystem. Manifest-backed actuators are treated as the current runtime surface. Directories without a manifest are treated as legacy-review components until they are either migrated or retired.

## Current Runtime Surface

- Source of truth: [global_actuator_index.json](../orchestration/global_actuator_index.json)
- Count: 23
- Rule: If a component should be discoverable by the CLI or governance layer, it needs a `manifest.json`.

- `agent-actuator`: Meta-Actuator for Agent Lifecycle and A2A (6 ops, v1.0.0, schema schemas/agent-action.schema.json)
- `android-actuator`: ADB-driven Android Device Actuator (1 ops, v1.0.0, schema schemas/mobile-device-pipeline.schema.json)
- `approval-actuator`: Human approval request state transitions and decision handling (4 ops, v1.0.0, schema schemas/approval-action.schema.json)
- `artifact-actuator`: Governed Artifact and Delivery Pack Manager (4 ops, v1.0.0, schema schemas/artifact-action.schema.json)
- `blockchain-actuator`: Immutable Ledger Anchoring System (2 ops, v1.0.0, schema schemas/blockchain-action.schema.json)
- `browser-actuator`: Pipeline-driven Playwright browser execution and session artifact actuator (2 ops, v1.0.0, schema schemas/browser-pipeline.schema.json)
- `code-actuator`: ADF-driven code analysis and refactoring pipeline engine (2 ops, v2.1.0, schema schemas/code-pipeline.schema.json)
- `file-actuator`: Generic File-Actuator for Kyberion (1 ops, v1.0.0, schema schemas/file-pipeline.schema.json)
- `ios-actuator`: simctl-driven iOS Simulator Actuator (1 ops, v1.0.0, schema schemas/mobile-device-pipeline.schema.json)
- `media-actuator`: Document and asset generation engine (1 ops, v1.0.0, schema schemas/media-pipeline.schema.json)
- `media-generation-actuator`: Generative image, video, music, and screen capture actuator (10 ops, v1.0.0, schema schemas/media-generation-action.schema.json)
- `modeling-actuator`: Architectural Analysis and ADF Transformation Engine (2 ops, v1.0.0, schema schemas/modeling-pipeline.schema.json)
- `network-actuator`: ADF-driven secure fetch and A2A transport pipeline engine (1 ops, v2.2.0, schema schemas/network-pipeline.schema.json)
- `orchestrator-actuator`: Mission/control-plane transformation and execution-plan orchestration actuator (2 ops, v1.0.0, schema schemas/orchestrator-pipeline.schema.json)
- `presence-actuator`: Human Presence and Messaging Bridge (3 ops, v1.0.0, schema schemas/presence-action.schema.json)
- `process-actuator`: Managed process lifecycle actuator backed by the runtime supervisor (4 ops, v1.0.0, schema schemas/process-action.schema.json)
- `secret-actuator`: OS Native Secret Manager Bridge (3 ops, v1.0.0, schema schemas/secret-action.schema.json)
- `service-actuator`: Unified External SaaS/API Reachability Layer (6 ops, v1.0.0, schema schemas/service-action.schema.json)
- `system-actuator`: OS-level control, diagnostics, and short-lived local execution (3 ops, v1.0.0, schema schemas/system-pipeline.schema.json)
- `terminal-actuator`: PTY-driven Terminal Actuator (5 ops, v1.0.0, schema schemas/terminal-action.schema.json)
- `vision-actuator`: Perception-oriented compatibility facade; generation and screen capture live in media-generation-actuator (2 ops, v1.3.0, schema schemas/vision-action.schema.json)
- `voice-actuator`: Local Generative TTS Actuator (Style-Bert-VITS2) (2 ops, v1.0.0, schema schemas/voice-action.schema.json)
- `wisdom-actuator`: Knowledge-tier search, injection, import, and export actuator (4 ops, v1.0.0, schema schemas/wisdom-action.schema.json)

## Legacy Review Queue

- Source of truth: [legacy_component_index.json](../orchestration/legacy_component_index.json)
- Count: 2

- `daemon-actuator`: Launchd-era runtime management overlaps with surface-runtime and managed process supervision.
- `physical-bridge`: Thin wrapper that shells into browser/system actuators and writes temp files instead of expressing the flow directly as ADF.

## Consolidation Recommendations

- Retire `physical-bridge` by expressing its orchestration as ADF over `browser-actuator`, `system-actuator`, and `media-generation-actuator` instead of shelling back through `cli.js`.
- Review `daemon-actuator` against `surface-runtime` and `process-actuator`; keep only one long-lived process lifecycle model.
- Treat `vision-actuator` as compatibility-only and continue moving generation concerns into `media-generation-actuator` while keeping perception-oriented work elsewhere.
- Keep `approval-actuator`, `code-actuator`, `network-actuator`, and `process-actuator` manifest-backed because governance or runtime layers still reference them directly.
- Do not use `CAPABILITIES_GUIDE.md` as the source of truth for runtime discovery; it is broader and currently includes historical capability names that do not map 1:1 to actuator packages.


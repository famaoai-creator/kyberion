---
title: Actuator Contract Map
category: Architecture
tags: [architecture, actuators, contracts, schemas, ux]
importance: 9
author: Ecosystem Architect
last_updated: 2026-03-23
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
- [`global_actuator_index.json`](knowledge/public/orchestration/global_actuator_index.json)

## Reading Rule

The current discovery model is:

1. find an actuator in the index or CLI
2. read its `manifest.json`
3. follow `contract_schema`
4. read the detailed step or action vocabulary there

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
| `system-actuator` | pipeline + control + computer interaction | `pipeline`, `reconcile`, `computer_interaction` | `schemas/system-pipeline.schema.json`, `schemas/computer-interaction.schema.json` | OS execution, diagnostics, focused-input and system input bridge |
| `terminal-actuator` | action + computer interaction | `spawn`, `poll`, `write`, `kill`, `computer_interaction` | `schemas/terminal-action.schema.json`, `schemas/computer-interaction.schema.json` | PTY contract plus terminal session interaction loop |
| `vision-actuator` | action + compatibility | `inspect_image`, `ocr_image` | `schemas/vision-action.schema.json` | Perception-first, legacy routes still described in schema |
| `voice-actuator` | action + lightweight pipeline | `speak_local`, `list_voices`, `pipeline` | `schemas/voice-action.schema.json` | Mixed contract explicitly documented |
| `wisdom-actuator` | action | `knowledge_search`, `knowledge_inject`, `knowledge_export`, `knowledge_import` | `schemas/wisdom-action.schema.json` | Knowledge-tier operations |

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

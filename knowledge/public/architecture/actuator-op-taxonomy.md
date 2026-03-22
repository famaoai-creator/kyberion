---
title: Actuator Operation Taxonomy
category: Architecture
tags: [architecture, actuators, capabilities, contracts]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-23
---

# Actuator Operation Taxonomy

This document defines how actuator `op` contracts should be shaped.

The goal is not to expose every internal helper through manifests.
The goal is to keep the public actuator catalog coherent, discoverable, and reusable.

## 1. Core Rule

`manifest.json` defines the canonical public contract.

An implementation may temporarily keep compatibility handlers for older flows, but compatibility behavior must not force the public catalog to expose a blurry or misleading `op` model.

## 2. Preferred Layers

Actuator `op` values should fall into one of these layers.

### A. Physical primitives

These directly touch the world.

Examples:

- `file.read`
- `system.shell`
- `terminal.spawn`
- `browser.pipeline`
- `media_generation.record_screen`

These belong in actuators that own the physical boundary.

### B. Semantic transforms

These convert one governed representation into another.

Examples:

- `terraform_to_topology_ir`
- `topology_ir_to_architecture_adf`
- `ui_flow_to_test_inventory`

These belong in modeling-style actuators.

### C. Control-plane actions

These coordinate missions, approvals, surfaces, or managed runtimes.

Examples:

- `approval.create`
- `process.spawn`
- `agent.spawn`
- `orchestrator.request_to_execution_brief`

These should not duplicate lower-level file or shell primitives unless there is a strong control-plane reason.

## 3. Anti-Patterns

The following patterns should be avoided in public manifests.

### A. Primitive duplication across multiple actuators

Bad examples:

- `shell` in both `system-actuator` and `orchestrator-actuator`
- `read_file` in both `file-actuator` and `system-actuator`
- generic text/query helpers scattered across unrelated actuators

If an `op` is a shared primitive, it should have one canonical owner.

### B. Domain-specific product logic inside physical actuators

Bad examples:

- `proposal_storyline_from_brief`
- `document_report_design_from_brief`

These are not media primitives. They are higher-level transforms and should live in modeling or orchestration contracts.

### C. Manifest contracts that do not match the real execution model

Bad example:

- exposing low-level browser ops in the manifest when the implementation is pipeline-only

The manifest must describe what callers should actually use.

### D. Compatibility facades presented as first-class capability owners

If an actuator exists only to preserve older call sites, its manifest should expose only the canonical subset or clearly narrow the contract.

## 4. Current Canonical Boundaries

- `file-actuator`
  - file CRUD and discovery
- `system-actuator`
  - OS control and short-lived local execution
- `terminal-actuator`
  - PTY lifecycle
- `browser-actuator`
  - pipeline-driven browser execution and session artifacts
- `media-generation-actuator`
  - generative media and screen capture/recording
- `vision-actuator`
  - perception-oriented compatibility surface only
- `orchestrator-actuator`
  - control-plane and execution-brief transforms
- `wisdom-actuator`
  - knowledge-tier operations

## 5. Normalization Direction

When consolidating a blurry actuator, prefer this order:

1. reduce the manifest to the canonical public contract
2. keep compatibility handlers only where migration still needs them
3. migrate callers to the canonical owner
4. remove the compatibility handler later

This keeps discovery clean before implementation cleanup is fully complete.

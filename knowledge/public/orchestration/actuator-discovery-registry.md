---
title: Actuator Discovery Registry
category: Orchestration
tags: [orchestration, actuators, registry, discovery]
importance: 8
author: Ecosystem Architect
last_updated: 2026-05-03
---

# Actuator Discovery Registry

Kyberion treats the actuator catalog as a registry, not as a loose list of
packages.

The registry has three layers:

1. **per-actuator package manifest**
2. **global compatibility snapshot**
3. **contract schema / capability probes**

## 1. Package Manifest

Each manifest-backed actuator owns its own `manifest.json` under `libs/actuators/*/manifest.json`.

The manifest is the local contract surface for that actuator. It provides:

- actuator id
- version
- description
- contract schema
- capability list

If a component is not manifest-backed, it is not part of the current
runtime catalog.

## 2. Global Compatibility Snapshot

[`global_actuator_index.json`](global_actuator_index.json) is the compatibility snapshot generated from the package manifests.

It remains readable for tooling that still expects the historical catalog shape, but it is no longer the canonical source of truth.

## 3. Schema and Probe

The schema defines the detailed shape of the actuator contract.
Runtime probes refine whether the capability is actually available in the
current environment.

## Discovery Order Rule

When Kyberion renders capability information or checks runtime availability:

1. use manifest-backed package order
2. fall back to lexical order only when a manifest catalog cannot be loaded

This keeps the runtime view aligned with the canonical package manifests and avoids
compatibility snapshot drift.

## Practical Implication

- `CAPABILITIES_GUIDE.md` remains a human-facing summary
- `global_actuator_index.json` remains a generated compatibility snapshot
- `manifest.json` remains the actuator-local contract source
- capability probes answer the "is it usable here?" question

That is the Kyberion equivalent of Hermes-style platform registry
self-registration, but expressed in actuator terms.

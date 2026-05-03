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

1. **global actuator index**
2. **manifest.json**
3. **contract schema / capability probes**

## 1. Global Actuator Index

[`global_actuator_index.json`](global_actuator_index.json) is the
human-readable and runtime-ordering catalog.

It defines:

- which actuators are considered current
- the order they should appear in discovery surfaces
- the canonical actuator id and package path

## 2. Manifest

Each manifest-backed actuator owns its own `manifest.json`.

The manifest is the local contract surface for that actuator. It provides:

- actuator id
- version
- description
- contract schema
- capability list

If a component is not manifest-backed, it is not part of the current
runtime catalog.

## 3. Schema and Probe

The schema defines the detailed shape of the actuator contract.
Runtime probes refine whether the capability is actually available in the
current environment.

## Discovery Order Rule

When Kyberion renders capability information or checks runtime availability:

1. use the global actuator index order
2. fall back to manifest-backed package order if needed
3. fall back to lexical order only when neither catalog signal is available

This keeps the runtime view aligned with the curated catalog and avoids
filesystem-order drift.

## Practical Implication

- `CAPABILITIES_GUIDE.md` remains a human-facing summary
- `global_actuator_index.json` remains the catalog order source
- `manifest.json` remains the actuator-local contract source
- capability probes answer the "is it usable here?" question

That is the Kyberion equivalent of Hermes-style platform registry
self-registration, but expressed in actuator terms.


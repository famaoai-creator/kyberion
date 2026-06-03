---
title: Legacy Capability Resources
tags: [reference, capability, legacy, migration]
importance: 6
author: Ecosystem Architect
last_updated: 2026-03-15
kind: reference
scope: repository
authority: advisory
phase: [alignment, execution, review]
role_affinity: [knowledge_steward, ecosystem_architect]
applies_to: [legacy-knowledge, migration]
owner: knowledge_steward
status: active
---

# Legacy Capability Resources

This directory stores capability-specific reference assets that support actuator and procedure execution.

It should not be treated as the primary conceptual model.

Current policy:

- executable capabilities live in `libs/actuators/`
- runnable discovery is defined by `libs/actuators/*/manifest.json`; `global_actuator_index.json` is the compatibility snapshot
- knowledge retrieval is governed by Knowledge Cards, overlays, and policy graphs

This directory remains only until the remaining capability resources are migrated into a final taxonomy location.

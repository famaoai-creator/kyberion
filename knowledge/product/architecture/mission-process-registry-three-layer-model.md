---
title: Mission Process Registry Three-Layer Model
tags: [mission, process-registry, governance, verification, knowledge]
last_updated: 2026-08-01
---

# Mission Process Registry: three layers

Kyberion separates process definitions into three deliberately different layers:

- **Runtime (R)**: machine-readable classification, workflow, and gate policy consumed by runtime code.
- **Verification (V)**: golden and controlled-failure scenario packs that execute the runtime chain and detect drift.
- **Knowledge (K)**: playbooks and lifecycle phase runbooks for people and context packs; they are not executable ADF and are not parsed into runtime steps.

`knowledge/product/governance/mission-process-registry.json` declares each artifact's layer, consumer, and validator. The binding checker verifies paths and vocabulary references across the layers. This keeps runbook guidance discoverable without turning prose into frozen execution logic.

---
title: Blueprint: Data Flow & Lifecycle Map
category: Templates
tags: [templates, blueprints, data, flow, lifecycle, map]
importance: 4
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Blueprint: Data Flow & Lifecycle Map
<!-- Owner: System Architect / Data Guardian -->
<!-- Visibility: [L2: MANAGEMENT, L3: SYSTEM/DATA] -->

## 1. High-Level Data Journey [L1] [DIAGRAM: Flowchart]
<!-- 指令: データの発生(Vault)から消費(Skills)、蒸留(Knowledge)までのライフフローを可視化せよ -->
- [DIAGRAM_START] { "intent": "strategy_map", "theme": "base" } [DIAGRAM_END]

## 2. Integration & Processing Paths [L3] [INVENTORY: Data Connectors]
- 2.1 Ingestion Methods (Manual Vaulting, Connectors)
- 2.2 Transformation Rules (ADF conversion logic)

## 3. Data Governance & Security [L2]
- 3.1 Encryption at rest/transit
- 3.2 Tier Isolation points (Tier Guard check locations)

## 4. Retention & Archiving [L3]
<!-- 指令: データの有効期限(TTL)とミッション終了後のクリーンアップルールを記述せよ -->
- 4.1 Ephemeral vs. Permanent Knowledge
- 4.2 Mission Artifact Archiving policy

---
title: Blueprint: Architecture Design (AIDLC Standard)
category: Templates
tags: [templates, blueprints, architecture, design]
importance: 4
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Blueprint: Architecture Design (AIDLC Standard)
<!-- Visibility: [L1: EXECUTIVE, L3: SYSTEM/DATA] -->

## 1. System Architecture Overview [L1] [DIAGRAM: 16:9 Map]
<!-- 指令: 今回進化したユニバーサル・レンダラーで構成図を出力せよ -->
- [DIAGRAM_START] { "intent": "system_architecture", "theme": "base" } [DIAGRAM_END]

## 2. Technology Stack & Skills [L2] [INVENTORY: Skills]
- 2.1 Applied Skill Infrastructure
- 2.2 External Services & API Dependencies

## 3. Data Design & Protocols [L3] [SCHEMA: ADF]
- 3.1 Global ADF Schema Definition
- 3.2 State Management & Persistence rules

## 4. Sequence & Interaction Logic [L2] [DIAGRAM: Sequence]
<!-- 指令: 正常系およびSelf-Healingのフローを可視化せよ -->
- [DIAGRAM_START] { "intent": "api_sequence", "theme": "dark" } [DIAGRAM_END]

## 5. Security & Governance Design [L2] [AUDIT: Rules]
- 5.1 Authentication & Authorization Matrix
- 5.2 Automated Audit Thresholds (Governance Guard)

## 6. Physical Directory Structure [L3]
<!-- 指令: codebase-mapperの結果に基づき物理配置を記述せよ -->
- [INVENTORY: Path Map]

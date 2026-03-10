---
title: Blueprint: API Reference
category: Templates
tags: [templates, blueprints, api, reference]
importance: 4
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Blueprint: API Reference
<!-- Owner: Engineer / Architect -->
<!-- Visibility: [L3: SYSTEM/DATA] -->

## 1. Endpoint / Skill Catalog [L3] [INVENTORY: Skills]
<!-- 指令: プロジェクトで使用される全API/スキルのIDと目的をスキャンせよ -->
- [SKILL_LIST]

## 2. Request / Input Specification [L3] [SCHEMA: ADF]
- 2.1 JSON Schema Definition
- 2.2 Required Parameters & Validation Rules
- 2.3 Example Payloads

## 3. Response / Output Specification [L3] [SCHEMA: ADF]
- 3.1 Success Structure
- 3.2 Error Codes & Messages
- 3.3 Data Consistency constraints

## 4. Authentication & Rate Limiting [L3]
- 4.1 Security Protocol (e.g., JWT, OAuth2)
- 4.2 Throttling thresholds (Token Economy)

## 5. Sequence Diagram [L2] [DIAGRAM: Sequence]
<!-- 指令: API間のインタラクションを可視化せよ -->
- [DIAGRAM_START] { "intent": "api_sequence", "theme": "dark" } [DIAGRAM_END]

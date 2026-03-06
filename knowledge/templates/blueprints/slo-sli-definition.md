---
title: Blueprint: SLO/SLI Definition
category: Templates
tags: [templates, blueprints, slo, sli, definition]
importance: 4
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Blueprint: SLO/SLI Definition
<!-- Owner: SRE / Auditor -->
<!-- Visibility: [L1: EXECUTIVE, L3: SYSTEM/DATA] -->

## 1. Reliability Objectives [L1]
- **Service Name**: Core AI API / Mission Control.
- **Availability Target**: (e.g., 99.9%).
- **Error Budget Policy**: Consequences of SLO violation.

## 2. Service Level Indicators (SLI) [L3] [METRICS: Performance]
<!-- 指令: 物理的なログやテレメトリから以下の指標を定義せよ -->
| Indicator | Metric Source | Success Threshold |
| :--- | :--- | :--- |
| **Availability** | HTTP 2xx/Total Req | > 99.9% |
| **Latency** | P95 Response Time | < 500ms |
| **Throughput** | Tasks per minute | Max 100 |
| **Token Efficiency** | Output/Input ratio | > 0.8 |

## 3. Monitoring & Alerting rules [L3]
- 3.1 Critical Alert Triggers
- 3.2 Dashboard Path (Chronos Mirror link)

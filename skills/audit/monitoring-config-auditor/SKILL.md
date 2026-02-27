---
name: monitoring-config-auditor
description: >-

status: implemented
arguments:
  - name: dir
    short: d
    type: string
    required: false
    description:
category: Audit
last_updated: '2026-02-16'
tags:
  - compliance
  - gemini-skill
  - observability
---

# Monitoring Config Auditor

This skill provides a proactive audit of your "Observability" setup before it goes to production.

## Capabilities

### 1. Alarm Integrity Check

- Scans for missing basic alarms (CPU, Error Rate, Disk Space).
- Verifies that thresholds match the project's Non-Functional Requirements.

### 2. Notification Audit

- Ensures that every alarm has a defined and valid notification destination (SNS, Slack, PagerDuty).
- Validates that high-severity alerts follow [PagerDuty Best Practices](../knowledge/operations/pagerduty_best_practices.md) (e.g., automated escalation, actionable context).

## Usage

- "Audit our current Terraform files for monitoring compliance."
- "Are we missing any critical alerts for this new microservice deployment?"

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`.
- References [Monitoring Best Practices](../knowledge/operations/monitoring_best_practices.md) for New Relic, Datadog, and general observability standards.
- References [SLO & Dashboard Best Practices](../knowledge/operations/slo_dashboard_best_practices.md) for service level management and visualization standards.
- References [Modern SRE Best Practices](../knowledge/operations/modern_sre_best_practices.md) for IaC monitoring and synthetic testing standards.
- References [PagerDuty Best Practices](../knowledge/operations/pagerduty_best_practices.md) for alerting standards.
\n## Governance Alignment\n\n- This skill aligns with **IPA** non-functional standards and **FISC** security guidelines to ensure enterprise-grade compliance.

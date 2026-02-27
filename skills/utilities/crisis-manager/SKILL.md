---
name: crisis-manager
description: >-

status: implemented
arguments:
  - name: log
    short: l
    type: string
    required: true
    description:
category: Utilities
last_updated: '2026-02-16'
tags:
  - data-engineering
  - gemini-skill
  - integration
  - security
---

# Crisis Manager

This skill is for high-stakes, time-sensitive situations where rapid recovery is paramount.

## Capabilities

### 1. Incident Diagnostic

- Rapidly correlates logs, security alerts, and recent commits to find the "smoking gun."
- Utilizes the "Three Pillars of Observability" (Metrics, Logs, Traces) as defined in [Monitoring Best Practices](../knowledge/operations/monitoring_best_practices.md).
- Suggests immediate workarounds or rollbacks.

### 2. Post-Mortem Preparation

- Captures the state of the system during the incident for later analysis.
- Drafts the initial incident report (What happened, Timeline, Immediate Action) following [PagerDuty Best Practices](../knowledge/operations/pagerduty_best_practices.md) for blameless post-mortems.

## Usage

- "We have a production outage! Run `crisis-manager` to analyze logs and recent changes immediately."
- "A critical zero-day was found. Coordinate with `security-scanner` to find all affected instances."

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
- Integrates [PagerDuty Best Practices](../knowledge/operations/pagerduty_best_practices.md) for incident roles (e.g., Incident Commander) and resolution workflows.
- References [Runbook Best Practices](../knowledge/operations/runbook_best_practices.md) for executing machine-readable diagnostic and remediation steps.

---
title: 30-Day Operations Evidence Template
category: Operator
tags: [production-readiness, evidence, operations]
importance: 8
last_updated: 2026-05-15
---

# EV-30DAY-OPS Evidence

Use this template after a real 30-day operation window. Keep secrets, customer PII, and private traces out of public artifacts.

## Environment

- Operator:
- Start date:
- End date:
- OS / version:
- Node / pnpm:
- Reasoning backend:
- Enabled actuators:
- Customer overlay or single-user mode:

## Daily Command Set

```bash
pnpm run doctor
pnpm pipeline --input pipelines/baseline-check.json
pnpm pipeline --input pipelines/verify-session.json
```

Add the use-case-specific mission or pipeline here:

```bash
# command:
```

## Results

- Total scheduled runs:
- Successful runs:
- Success rate (must be >= 95%):
- Human interventions:
- Interventions per week (must be <= 1):
- Unknown errors:
- Unknown error rate (must be <= 10%):

## Evidence Refs

- Trace bundle:
- Screenshot or first-win artifact:
- Incident summary:

## Incidents

| Date | Scenario | Classification | Remediation | Follow-up |
|---|---|---|---|---|
| | | | | |

## Reviewer Decision

- Reviewer:
- Reviewed at:
- Decision: pending / verified / rejected
- Notes:

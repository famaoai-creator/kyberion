---
title: FDE Deployment Evidence Template
category: Operator
tags: [production-readiness, evidence, fde, deployment]
importance: 8
last_updated: 2026-05-15
---

# EV-FDE-DEPLOY Evidence

Use this template after a real external FDE or SI completes a customer deployment without forking Kyberion. Exclude secrets and customer PII from public artifacts.

## Deployment Context

- FDE / SI:
- Customer slug or anonymized label:
- Deployment environment: macOS / Linux / Docker / other
- Start date:
- Completion date:
- Customer overlay paths used:
- Runtime capabilities required:

## Commands

```bash
pnpm customer:create <slug>
pnpm customer:switch <slug>
source active/shared/runtime/customer.env
pnpm onboard
pnpm run doctor
```

Add customer-specific verification commands:

```bash
# command:
```

## Results

- Deployment completed without fork: yes / no
- Product code patches required: yes / no
- Config or template changes only:
- External FDE / SI completed deployment: yes / no
- Mission / pipeline artifacts:
- Trace bundle:
- Screenshot or operator artifact:

## Postmortem

- What worked:
- What blocked:
- Workarounds:
- Follow-up issues:

## Reviewer Decision

- Reviewer:
- Reviewed at:
- Decision: pending / verified / rejected
- Notes:

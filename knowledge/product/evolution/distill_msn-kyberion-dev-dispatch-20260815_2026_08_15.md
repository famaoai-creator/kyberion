---
title: 'Tenant-scoped mission dispatch with provider-independent CLI guards'
category: Evolution
tags: ['improvement_experiment', 'mission-dispatch', 'TypeScript', 'multi-tenant', 'CLI-governance']
importance: 6
source_mission: MSN-KYBERION-DEV-DISPATCH-20260815
author: Kyberion Wisdom Distiller
last_updated: 2026-08-15
---

# Tenant-scoped mission dispatch with provider-independent CLI guards

## Summary

The mission strengthened mission-to-WorkItem dispatch by propagating typed project context, applying tenant-scoped fallback and dependency-readiness rules, and prioritizing explicit project selection. It also moved help and required mission-ID validation ahead of provider bootstrap, then completed evidence-bound verification with no review findings.

## Key Learnings

- Dispatch context should be represented as typed fields and resolved with explicit project context taking precedence over tenant-scoped fallback; this preserves traceability without weakening tenant isolation.
- Provider-independent CLI checks such as help handling and required identifier validation should run before reasoning-provider bootstrap so deterministic commands remain usable when provider startup is unavailable.
- Completion confidence increases when implementation, regression tests, contract validation, provider-sync auditing, watchdog probing, Work Graph projection, and independent review are bound into the mission evidence chain.

## Patterns Discovered

- Use the sequence explicit context → tenant-scoped fallback → dependency-readiness validation when creating governed WorkItems; it gives predictable routing while preventing cross-tenant ambiguity.
- Keep deterministic argument validation at the outer CLI boundary and defer adapter or runner initialization until execution actually requires it.
- Repeated review and reconciliation work items can progressively close evidence gaps, but dispatch telemetry should distinguish genuine progress from redundant redispatches.

## Failures & Recoveries

- Provider CLI execution encountered sandbox failure → the failure was preserved as evidence and the authorized mission owner completed the work through an NHI takeover, without assuming or hard-coding another provider.
- No mission status transition from failed back to active occurred.

## Reusable Artifacts

- libs/core/mission-workitem-dispatch.ts
- Mission CLI help and required mission-ID guard introduced in checkpoint 3a377b5f
- Tenant-context dispatcher regression suite, including 32 dispatcher/onboarding checks and the broader 88-test CLI/router verification
- Evidence-bound provider sync audit, supervisor watchdog probe, and Work Graph projection from checkpoint 8c36a78c

---

_Distilled by Kyberion | Mission: MSN-KYBERION-DEV-DISPATCH-20260815 | 2026-08-15_

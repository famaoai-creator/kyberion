# Intent Learning Seed Cache Plan

This note preserves the old migration boundary for the intent learning seed cache and points to the canonical rationale.

Canonical rationale:

- [knowledge/product/architecture/stale-doc-cleanup-rationale-2026-06.md](../knowledge/product/architecture/stale-doc-cleanup-rationale-2026-06.md)

Stable scope:

- `libs/actuators/orchestrator-actuator/src/super-nerve/resolver.ts`
- `knowledge/product/governance/standard-intents.json`
- `libs/core/contextual-intent-frame.ts`
- `libs/core/contextual-intent-learning.ts`

Contract terms:

- deterministic static pipeline mappings
- start-service and stop-service
- `source: seed`
- `tier: public`
- No runtime behavior change

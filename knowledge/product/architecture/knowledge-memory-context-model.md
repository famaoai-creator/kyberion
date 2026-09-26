---
title: Knowledge and Memory Context Adapter Model
tags: [memory, knowledge, context, adapter, promotion, tiering]
last_updated: 2026-09-26
---

# Knowledge and Memory Context Adapter Model

Memory and knowledge are related but have different lifetimes. Memory is volatile working state; knowledge is a durable reference asset with provenance and approval history.

```text
capture -> normalize -> resolve scope/tier -> store -> recall
-> propose promotion -> approve -> publish -> verify -> archive/forget
```

`KnowledgeContext` is storage-neutral. It carries purpose, tier, tenant scope, provenance, retention, and `training_use`. Storage and synchronization systems register as `KnowledgeAdapter` capabilities: `capture`, `recall`, `proposePromotion`, `publish`, `archive`, and `forget`. Callers select a capability through the seam and do not branch on a vendor or storage tool name.

The existing `working-memory-actuator` remains the volatile memory implementation, `memory-promotion-queue` remains the promotion proposal store, `KnowledgeProvider` remains scoped read access, and the Cowork bridge remains an external synchronization adapter. The shared context and seam allow those pieces to converge incrementally without replacing them in one migration.

Promotion from personal or confidential material to public requires provenance, redaction, and approval. `training_use` defaults to `local_only`; external use must be explicit.

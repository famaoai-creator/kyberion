---
title: Runtime plugin mounting by the model
status: rejected
decision_date: 2026-08-17
scope: plugin activation and operation registration
decision: Do not allow a model or untrusted workflow to mount runtime plugins.
rationale: Dynamic mounting would bypass Kyberion's approval, provenance, tenant-scope, and managed-copy gates; activation must remain an explicit human-governed lifecycle.
---

Kyberion adopts the useful seam and reversible-registration ideas from DeepSeek harness, but keeps
activation behind the managed plugin loader and provenance gate. A model may propose a contribution;
it cannot make that contribution executable by writing a manifest or importing a module.

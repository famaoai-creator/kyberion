---
category: Added
---

- **Scope governance plane doc + invariants (SC-09)** — `knowledge/product/architecture/scope-governance-plane.md` is the canonical doc for the unified scope model (two-layer envelope, governed flow, per-mechanism responsibilities), cross-linked from `entity-scope-hierarchy.md`. `scope-governance-invariants.test.ts` pins the convergence contract fail-closed: envelope minting only at dispatch boundaries, tenant only on declared record fields, fixed preflight stage order, and the facade-only control-plane construction site.

---
category: Added
---

- **Provenance egress guard + hash-bound declassify (SC-06)** — `evaluateProvenanceEgress` is now the single tier/tenant rule shared by `assertEgressAllowed` and the new `core:provenance-egress` waterfall stage (order 118): `effect: egress` ops that declare `target_audience`/`target_tenant` are blocked when mission taint forbids it — external audience always, unobserved tenants, and tier-lowering flows (rollout modes per op family). `requestDeclassify` files a held effect which, once human-approved and applied, journals a `declassification` grant that lets exactly one `payloadHash` through to one destination — mission taint itself never drops.

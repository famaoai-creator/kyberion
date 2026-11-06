---
category: Changed
---

- ResourceAccessScope enforcement and the private DOT result guard now share one pure operation-ceiling decision. Existing issuer, role, root, tenant and content controls remain mandatory; unknown runtime operations are explicitly denied before prefix or metadata matching. Latest split-branch S1 verification fixes were merged before this increment.

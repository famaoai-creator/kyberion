---
category: Changed
---

- **Held decisions unified into the approval store (SC-04, part 2)** — `submitHeldAction({ steeringApproval })` now files a `held_effect` approval request, making the shared store the decision of record. A human deciding via `decideApprovalRequest` (any approval surface, any process) settles the held action through the held-effect bridge into the control-plane journal; a linked `decideHeldAction` settles the request first — one approval path either way. First decision wins; executors still apply in the owner process.

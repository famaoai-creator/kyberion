---
category: Security
---

- A task resumed after a customer decision now receives the confirmed answers to its own questions in its prompt. The values are kept in memory only, and only for a mission whose context may carry that tenant's confidential data; otherwise the task is held with `customer_decision_tier_mismatch` and nothing is sent. Persisted records carry decision ids only, and answers echoed in task results are replaced with decision ids before they reach shared stores.
- Customer-decision invite storage now requires the tenant to be active in the tenant registry. For an inactive tenant only a revoke is accepted; `customer-decision send` refuses and the customer room answers "unavailable". Offboarding a tenant now also exports and removes its invites. Upgrade note: tenants without an active registry profile can no longer issue or open invites.

---
category: Security
---

- Bind signed agent workload credentials to the active canonical identity, its accountable human, tenant affiliation and current identity revision. Reject tenant fallback, malformed claims and lifetimes outside 1–900 seconds.
- Previously signed tokens lacking the required owner, explicit tenant scope or identity revision are rejected. An identity journal change also invalidates outstanding tokens; no automatic renewal, signing-key creation or new issuance endpoint is introduced.

---
category: Fixed
---

- Show a customer-decision task lock frozen by an unapproved `superseded` mark. `customer-decision overview` counts it (`frozen_locks`, first on the attention list), the case detail and the Chronos card mark the task frozen, and `customer-decision status` lists each one with the repair step. Previously only a one-time log warning revealed it.
- The Chronos customer-decision views now read the `unresolvable` task count the core already emits.

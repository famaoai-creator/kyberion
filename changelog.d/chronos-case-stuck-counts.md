---
category: Fixed
---

- Chronos case detail keeps both stuck-task signals the customer-decision facade already emits. `unresolvable` / `unresolvable_next` is a question whose agenda closed with no confirmed answer (the lock still accepts a re-ask or a task replacement). `frozen_locks` / `frozen_locks_next` is a lock an unproven `superseded` mark has closed to writes. A count an older facade omits reads as 0. Only `frozen_locks` is an attention reason.

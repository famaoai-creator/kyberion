---
category: Fixed
---

- Reconcile-work, the Work Graph projection apply and the orchestrator actuator's task plan now write `NEXT_TASKS.json` through the leased board writer. Reconcile-work writes only the tasks it adopted or repaired and keeps every other task as it stands on disk, so a worker's status write made during its WorkItem updates is no longer lost. The projection apply checks drift again on the board read under the lease. All three keep a superseded task's record. A task plan that is not a valid board (for example a missing dependency, or a code-change plan without a reviewer task) is now refused when it is written, instead of later at dispatch.

---
category: Fixed
---

- Reconcile-work, the Work Graph projection apply and the orchestrator actuator's task plan now write `NEXT_TASKS.json` through the leased board writer.
  - Reconcile-work writes the tasks it adopted or repaired. Every other task keeps its current board entry, unless its WorkItem already closed it. A worker's status write made during reconcile-work's WorkItem updates is no longer lost.
  - The projection apply checks drift again on the board read under the lease, and reports the drift it decided on.
  - A new orchestrator plan keeps a task superseded on disk. A plan task that depends on, or reviews, a superseded task is pointed at its replacement, and the reported `task_count` is the board as written.
- A board rebuilt from canonical state (the projection apply, reconcile-work) keeps a task's `superseded` status when the mission proves the supersede (an approved `supersede-task`). An unproven one is still dropped. `writeMissionNextTasks` takes this as the new `acceptProvenSupersede` option.

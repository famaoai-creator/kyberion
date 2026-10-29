---
category: Fixed
---

- `NEXT_TASKS.json` writers now read, guard and write the board under one writer lease. `writeMissionNextTasks` accepts an update function applied to the board as it stands under the lease. `supersede-task`, the orchestration progress writer, the planner's packet write and `reissueBlockedMissionTasks` (resume) use it, so a worker result written while they run is no longer lost. `supersede-task` also leaves a dependent that closed in the meantime unrewired.
- Every path where a worker blocks a task (not only a customer-decision hold) now ends the WorkItem attempt and releases its lease, so resuming the task right away no longer fails with a lease conflict.
- A new plan registers its WorkItems after the supersede guard, so a dependency on a superseded task is registered as its replacement. Only the plan's own tasks are registered: a replacement the plan leaves out keeps its WorkItem, rather than being reset to `ready` and dispatched again.

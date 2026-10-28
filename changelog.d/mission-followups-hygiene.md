---
category: Fixed
---

- A stale copy of a mission's `NEXT_TASKS.json` can no longer undo a `supersede-task`: the superseded task stays frozen as written, its replacement stays on the board, and dependents keep every rewrite, followed through chains of supersedes (T1 → T2 → T3). Only `supersede-task` can introduce a superseded task. The rule used to live only in the orchestration progress writer; it now sits in one guard applied by the planner's packet write and by the shared `writeMissionNextTasks`, which process-template planning (including `--refresh-catalog`), phase-gate status flips, task recovery, ticket dispatch and the dispatch reviewer now write through. A phase-gate verdict no longer re-runs or completes a superseded task. `review-task` closes its task under the mission lock and leaves a task held for a customer decision open, as `record-evidence` does. The orchestrator's `task-plan` op still replaces the whole board with a new plan, as before.
- A task put on hold for a customer decision now releases its WorkItem lease (`updateWorkItem({ status: 'blocked', endAttempt: true })`). The lease used to stay for up to 15 minutes, so resuming the task right after the customer decided failed with a lease conflict.
- `customer-decision status` reads a lock's superseded mark through the same proof as the mission-side boundaries (`decisionLockSupersedeProof`), so the two cannot disagree.
- `scripts/actuator_playground.test.ts` records into a per-run scratch directory, so a second local run no longer fails on the first run's sessions.

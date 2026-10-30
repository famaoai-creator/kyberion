---
category: Fixed
---

- More `NEXT_TASKS.json` writers now read and change the board under its writer lease, rather than writing back a copy read earlier. These are ticket dispatch, requested-task recovery, record-evidence and review auto-complete, the goal-gap and gate-repair tasks, the finish gate's repair auto-resolve, the review reopen, the dispatch reviewer's receipt, process-template planning and its gate verdicts, and the scope approval's drift repair. A worker's status write that lands while one of them runs, for example during ticket dispatch's WorkItem calls, is no longer lost.
- An update passed to `writeMissionNextTasks` now gets its own copy of the board. Before, an update that edited the board in place also changed the copy the supersede guard compared against, so a superseded task could be changed.
- Requested-task recovery records a resume only on a task that is still requested and still on the same WorkItem, and logs a claim it could not record.

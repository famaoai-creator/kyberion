---
category: Fixed
---

- The remaining `NEXT_TASKS.json` writers now read and change the board under its writer lease, rather than writing back a copy read earlier. These are ticket dispatch, requested-task recovery, record-evidence and review auto-complete, the goal-gap and gate-repair tasks, the finish gate's repair auto-resolve, the review reopen, the dispatch reviewer's receipt, process-template planning and its gate verdicts, and the scope approval's drift repair. A worker's status write that lands while one of them runs, for example during ticket dispatch's WorkItem calls, is no longer lost.

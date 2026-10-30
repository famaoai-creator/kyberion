---
category: Fixed
---

- **The board-lease follow-ups record and report what they repair.**
  - **supersede-task:** dependents added while it runs are now recorded in three places, with no duplicates, even when a run crashes and is resumed: the receipt (`late_rewritten_dependent_task_ids`), an audit entry (`mission.task_supersede_dependents_rewired`) and a ledger entry (`task_supersede_dependents_rewired`).
  - **reconcile-work:** a dry run now reports the `repair-finish-exit` board repair. A new test shows that the board-repair path refuses a task whose contract no longer matches the approved manifest.

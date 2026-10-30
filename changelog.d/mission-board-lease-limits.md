---
category: Fixed
---

- **The board writer's remaining known gaps are closed.** Four fixes:
  - **reconcile-work:** a re-run now repairs the board after an earlier run updated WorkItems but stopped before writing the board. The stale tasks are validated again against the approved manifest and their records rebuilt (`board_repaired_task_ids`). A missing receipt is written. Ledger entries are not recorded twice.
  - **Orchestrator task plan:** a plan task is pointed at a replacement only when the mission proves the supersede.
  - **record-evidence auto-complete:** it checks a snapshot of the board outside the writer lease, then writes only if the board is unchanged. It re-checks a changed board up to three times, then checks under the lease. A long cascade no longer holds the lease past its timeout.
  - **supersede-task:** it now rewires dependents added while it runs, both on the board and in WorkItems.

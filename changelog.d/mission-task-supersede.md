---
category: Added
---

- Add `mission_controller supersede-task <MISSION> <task> --by <new_task_id> --reason <text>`: replace a task that can no longer complete (e.g. its customer decision is unresolvable) with another task of the mission. It always needs an authenticated human `mission_gate` approval (`--request-approval`, then `--approval-request-id`; `--dry-run` checks only). The old task becomes `superseded` (closed, never completed), its dependents move to the replacement on NEXT_TASKS and their WorkItems, the old WorkItem is archived with `superseded_by`, and its customer-decision consumer lock is frozen. The finish gate, triage, flow projection, retrospective, continuous owner and Chronos progress treat `superseded` as closed.
- Escalate a customer decision pin that never succeeds: after 3 consecutive failed dispatch rounds the task is blocked (`customer_decision_check_failed`, hold reason `pin_failed_repeatedly`) and the mission owner is notified once (orchestration observation and an ids-only operator inbox entry).

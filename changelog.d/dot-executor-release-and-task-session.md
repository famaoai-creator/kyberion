---
category: Changed
---

- Dots no longer loop on `task_session`: it is no longer a default `allowed_work_shapes` value, and dispatch refuses a `task_session` proposal before the gate or any operator ask while no governed task-session executor is configured (even when a charter declares it). Wake prompts list the allowed shapes and `allowed_pipelines`, and proposal instructions steer to `pipeline` or `direct_reply`. A legacy `task_session` WorkItem is closed as blocked with `reason_code: capability_unavailable` and no report-back wake.
- New `pnpm kyberion dot release <dot_id> <work_item_id> --reason "<text>" [--by <operator>]`: an audited (`dot_work_item_operator_release`) operator release of a quarantined or escalated dot WorkItem. It records `metadata.dot_executor.operator_verified_at/by/reason` and returns the item to `ready`; the executor re-attempts it under a new attempt id.
- The dot executor classifies provably pre-effect failures (no backend resolved, pipeline missing or invalid, goal driver failing before its first model call) as retryable — back to `ready` for up to 3 attempts, then an escalated failure — instead of an uncertain quarantine. An item without `requested_work_shape` is blocked instead of defaulting to `task_session`.
- Executor report recovery no longer re-reports historic results that predate it (rows without `report_to_dot_id`), and each sweep reads a dot's work results once.

---
category: Added
---

- **Resident-dot loop contracts** — dot charters gain optional `goal.key_results`, `goal.outcome_settle_minutes`, `authority.allowed_pipelines`, `event` triggers, `runtime.cron_catch_up_hours`, `memory`, `followups`, `autonomy`, `team.owns`/`priority`, and object-form `team.goal_ref`; proposals gain `pipeline_ref`, `expected_effect`, `target`, `intent`. The charter validator recompiles when the schema file changes, and tenant charters under `knowledge/confidential/<slug>/dots/` are now discovered. New `dotStatePath` / row types and `key-result-spec` helpers. Existing charters are unchanged. No action needed.

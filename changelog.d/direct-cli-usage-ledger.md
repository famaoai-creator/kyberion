---
category: Added
---

- **Direct-CLI mission work shows up in usage accounting** — when `mission_controller record-evidence` or `review-task` completes a task it now appends one estimated entry (`status: estimated`, `source: direct_cli`, quantity/cost 0, token fields null — nothing fabricated) to the existing resource-usage ledger (`work/metrics/resource-usage.jsonl`), carrying mission/task scope, actor id and provider (new optional `--provider` flag, otherwise inferred from a provider-prefixed `--actor-id`). The retrospective stats gain `tasks_completed` and `usage_unrecorded` (completed tasks but zero usage entries of any kind), and the rendered retrospective states plainly that such zeros mean "not recorded", not "free".

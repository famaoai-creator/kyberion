---
category: Added
---

- Add `libs/core/ops-health.ts` (`evaluateOpsHealth`): per-item resident-ops findings — overdue / failing schedules, chronos crash loop and failing ticks, an empty registry while pipelines declare schedules, stale or missing backup archives, a failed `backup-daily`, a missing / stale / failed / skipped restore drill, a stale or failed janitor, missing required units, units pointing at another checkout, legacy units, units double-owned with an enabled surface, and a trigger delivery store near its read cap. Each finding names a concrete next command.
- Baseline: L10 now fails on per-schedule overdue / failing and crash-loop findings (a fresh heartbeat from a crash-looping chronos no longer passes), and the new L12 resident-ops layer reports the rest; both degrade only to `needs_attention`. The report gains an `ops_health` block. `pnpm kyberion doctor` prints the same findings as verdict lines.
- Chronos heartbeats carry `started_at`, `restarts_1h` / `restarts_24h` and the last tick outcome, and the healthy heartbeat is refreshed only after a tick completes.
- The restore drill writes `active/shared/runtime/state/backup-drill-last.json` on success, failure and a distinct `no_archive` skip; the baseline-submitted janitor run keeps its output in `active/shared/logs/process/baseline-janitor-maintenance.log` and records `janitor-last-failure.json` on a non-zero exit.

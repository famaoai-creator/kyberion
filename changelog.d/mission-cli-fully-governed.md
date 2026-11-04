---
category: Changed
---

- `mission_controller` no longer mutates mission state through `missionSystem` directly: `purge` now runs the governed `archive` sweep (with `onCandidates` for the CLI preview table), and project-ledger sync (`sync-project-ledger`, plus the post-handoff sync) goes through `missionLifecycleService`, so every mutating CLI verb shares the facade's execution-context gate and audit record. Only the read-only `team` view still reads the mission system directly.

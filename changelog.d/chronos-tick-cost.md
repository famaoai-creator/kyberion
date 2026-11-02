---
category: Fixed
---

- Chronos no longer re-reads every pipeline run journal on each tick. The await-state sweep remembers runs whose journal is finished or not waiting on a state probe and re-reads one only when its file changes; it also yields during long passes so the daemon heartbeat stays fresh. On a long-lived checkout a tick's sweep dropped from about 180 s to under 1 s.
- The weekly `ce-chronos-perf` schedule can write its report again: `check chronos-perf` now has a registered authority role whose only write is `active/shared/observability/chronos/ce-08-perf-baseline.json`.

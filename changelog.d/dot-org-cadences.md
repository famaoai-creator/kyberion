---
category: Added
---

- **Scheduled organization cadences (DL-06)** — `core:organization_operation_tick` (runs due scheduled operations every 15 minutes; tick core extracted into `libs/core/organization/organization-operation-tick.ts`, the CLI is now a thin wrapper), `core:organization_standup` (weekday standup) and `core:organization_retro` (weekly retro). Each report is filed in the organization's scope and sent to the operator inbox. The three pipelines ship opt-in (`enabled: false`; enable with `KYBERION_CHRONOS_SCHEDULES`). No action needed.

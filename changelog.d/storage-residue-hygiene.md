---
category: Fixed
---

- **Storage janitor report coverage** — `pipelines/storage-janitor.json` now renders every `JanitorReport` field (workspaces/unregistered dirs, empty mission dirs, uncovered runtime & event-store dirs, review-required dirs, trash, catalog warnings), so silent accumulation is no longer invisible in `active/shared/runtime/reports/storage-janitor-report.md`.
- **Retention under `run_pipeline`** — added the missing `allow_write` grants (`active/shared/observability/`, `active/shared/coordination/`, `presence/bridge/runtime/`, `active/archive/.trash/`) so event-store and trash TTLs actually delete; previously they reported `Expired: N / Deleted: 0` silently. Event-store sweeps also now skip tracked keep-files (`.gitignore`, `.gitkeep`, `.gitattributes`).
- **Mission hygiene** — new `pnpm mission sweep-empty-dirs [--execute]` verb removes empty mission directories under `active/missions/` through mission_controller authority (dry-run by default; protects `.git`/`node_modules`, symlinks, tier roots), and a scheduled `pipelines/mission-hygiene-weekly.json` (`core:run_mission_hygiene` op) audits stuck/abandoned missions weekly.

---
category: Fixed
---

- **ops alerts reach the operator inbox without configuration** — critical alerts (e.g. stale daemon heartbeat) now land in the deliverable inbox when no webhook/notification prefs exist, instead of only recording an undelivered envelope.
- **baseline-check detects stale dist** — L2 fails into `needs_recovery` with a `pnpm run build` hint when compiled artifacts import workspace subpaths the current manifests don't export; `dist-workspace-imports` now also covers `dist/libs` (workspace imports only).
- **invisible missions get an actionable error** — grant/sudo verbs now say "run `pnpm mission repair`" when the mission exists but isn't visible to this tenant scope.

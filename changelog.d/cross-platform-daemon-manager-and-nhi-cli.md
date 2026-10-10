---
category: Added
---

- **Cross-platform daemon manager** — `pnpm kyberion scheduler install/restart/status` now works on Linux (`systemd --user`, including `.timer` units for interval jobs) as well as macOS launchd; Windows daemons stay managed through the surface commands. Nothing to migrate: existing LaunchAgents keep working.
- **`pnpm nhi` facade** — issue/list/show/suspend/resume/retire governed NHI ledger entries directly, which route-3 tenant onboarding needs for the `nhi_provisioned` probe without a mission or `onboard company`. Mutations are dry-run by default; `--apply` writes under the mission_controller governed role.
- **`startupMode: "on-demand"` for surfaces** — client-spawned surfaces (e.g. the stdio MCP server `mcp-server-cowork`) are no longer supervised or flagged stale; set `startupMode: "on-demand"` in the surface manifest for processes an external client launches.

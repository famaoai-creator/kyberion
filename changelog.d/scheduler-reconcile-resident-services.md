---
category: Added
---

- Add `pnpm kyberion scheduler reconcile [--apply] [--include <id>]`: syncs the schedule registry without the daemon, diffs `resident-services.json` against the units the host service manager actually has, installs checkout-scoped units, migrates a legacy unit of this checkout, reinstalls on unit or node path drift, and never touches another checkout's units. Dry-run by default and idempotent; the setup report suggests it while services are pending.
- Add `libs/core/daemon/installed-units.ts` (`inspectInstalledUnits`) to list installed launchd / systemd user units with scope, checkout root, ownership and load state.
- Fix the daemon watchdog restarting and naming the legacy global label instead of this checkout's scoped unit, and key daemon recovery once per unhealthy episode (or 15-minute bucket) instead of once per minute.

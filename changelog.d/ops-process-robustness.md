---
category: Fixed
---

- **Chronos ticks no longer overlap and the daemon stops cleanly** — the scheduler now uses a serial tick loop (the next tick is armed only after the previous one settles), so a slow tick no longer produces a misleading "Another scheduler leader owns this tick". SIGTERM/SIGINT stop the timer, wait up to 30s for the in-flight tick, release the leader lease, record a `stopping` heartbeat with `details.state: "stopped"` and exit 0.
- **Generation schedule daemon tick deadline** — each tick child is killed at its deadline (SIGTERM, then SIGKILL after 5s) with a dedicated `generation-schedule-daemon:tick-timeout` ops alert. The default is max(5 × interval, 15 min); override with the new `KYBERION_GENERATION_SCHEDULE_TICK_TIMEOUT_MS`. SIGTERM/SIGINT are forwarded to the tick child before the daemon exits 0.
- **Environment probes and installs cannot hang doctor/preflight** — capability command probes time out after 10s (reported as unavailable: `timed out after 10s`), and install commands after 10 minutes with an explicit reason.
- **Keychain and mail helpers survive missing or hung binaries** — `security`/`swift` (macOS Keychain) and `osascript`/`python3` (mail) children now handle spawn errors (resolve to `null` / `failed` instead of crashing) and are killed at a bound (10s keychain read/delete, 60s keychain write and mail send).
- **`purgeMissions` no longer writes to stdout** — the library returns the candidate rows; `pnpm mission purge` renders the same table, and the weekly-audit / mission-hygiene pipeline output stays parseable.
- **Library warnings reach the log file** — remaining `console.warn`/`console.error` calls in `libs/core` now go through the shared logger, the vision tie-break dialogue goes to stderr, and ESLint's `no-console` is now enforced for non-test `libs/**` code.

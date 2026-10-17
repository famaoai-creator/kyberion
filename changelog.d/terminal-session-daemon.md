---
category: Added
---

- **Persistent terminal sessions via `pnpm terminal`** — a Unix-socket daemon (`pnpm terminal serve|status|stop`, auto-started on first use under `active/shared/runtime/terminal-daemon/`) fronts the terminal actuator's `--serve` loop, so PTY sessions spawned with `pnpm terminal spawn` survive across CLI calls and remain reachable by `write`/`poll`/`resize`/`kill`/`list`.

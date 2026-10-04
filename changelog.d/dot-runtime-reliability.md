---
category: Fixed
---

- **Resident dots no longer go silent on one bad charter** — a wake re-reads only its own charter file; a malformed sibling no longer marks every dot "unreadable", and an unreadable own charter is recorded as a failed wake with the real validation error and a `pnpm kyberion dot validate <id>` hint.
- **Failed wakes back off instead of flooding** — retries per trigger key double from 5 minutes up to 6 hours, and a dot whose last 5 wakes failed for the same reason holds all triggers (one ops alert per opening, then a single probe wake after the backoff).
- **No more fake deliveries from the stub backend** — the supervisor daemon now installs real reasoning backends at start and re-selects them every 30 minutes (and right after a sweep where every wake failed on the backend). A process that only has the placeholder backend records the wake as failed instead of logging `[STUB]` text as delivered; a tool loop with no live tool-capable provider falls back to fenced proposals within the same wake.
- **Supervisor heartbeat shows what is wrong** — `charter_errors` lists skipped charter files, and `stale_code: true` flags a daemon that runs an older core build than the one on disk (restart it to pick up fixes).
- Dots also wake when their own executor reports a finished work item, and later capabilities plug in through `dot-extension-registry` (prompt sections, wake tools, floors, pre-gate checks, relaxers, digest sections) and `DOT_SUPERVISOR_STEPS`. No action needed.

---
category: Changed
---

- **Hearing logic moved into core** — the `/ask` hearing mode's logic now lives in `libs/core/surface/` (`hearing`, `hearing-runtime`, `hearing-canvas`, `hearing-a2ui`, `hearing-ledger-canvas`, `hearing-mission`, `hearing-work-inventory`, `hearing-storage-access`, `hearing-scope`, `hearing-completion`, `hearing-handoff-snapshot`, `ask-view`) instead of only in presence-studio, so Concierge can serve the same hearing next. Nothing changes for you: Studio serves the same routes, with the same checks, roles, statuses and error codes, and keeps hearing records where they were.

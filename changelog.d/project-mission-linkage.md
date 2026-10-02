---
category: Fixed
---

- **Project ↔ mission membership is derived from one source** — a mission's `relationships.project` / `relationships.track` is now the only source of truth; project operational state, track state and the project record's `active_missions` / `active_tracks` are rebuilt from it on every mission sync. Finished missions leave the active lists (they used to stay forever), and a track keeps all of its active missions (it used to keep only the last one synced). Linking a mission requires a registered project (`[PROJECT_LINK_INVALID]`) and inherits the project's tenant and organization (a conflicting `--organization-id` is rejected). `pnpm project show` now lists archived missions and the project's artifact records. The unread per-mission `mission-link.json` is no longer written.

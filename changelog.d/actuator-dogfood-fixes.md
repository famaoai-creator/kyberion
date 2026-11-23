---
category: Fixed
---

- **Interactive browser ref ops now execute.** `browser control click <ref>` (and every ref-based step) previously always failed with "対象の役割または名称が記録時から変化しました" — interactive steps carry no `role`/`name` and the content script compared them against `''`. Empty role/name are now treated as unconstrained; recorded steps still enforce the strict drift check.
- **Exported `open_tab` no longer breaks replay.** The session-establishing step produced an action the `browser-recording.v1` schema cannot express (no `url` field), so `browser run --procedure-id` failed validation. `open_tab` is now skipped at export — replay opens `recording.tab.origin` itself.
- **`browser control promote` persona requirement documented** (`KYBERION_BASE_ROLE` + `MISSION_ID`) in the browser-control playbook — a bare shell's persona `unknown` is tier-denied on `procedures.json`.

Found by live dogfooding in MSN-ACTUATOR-DOGFOOD-20261123.

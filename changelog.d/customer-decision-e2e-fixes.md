---
category: Fixed
---

- **Customer decision: bolt review of a finished confidential tenant mission** — `customer-decision bolt-review` (and the next bolt's `bolt-after` milestone) now read an archived tenant mission's state bound to that tenant inside an exact one-file capability, so the operator CLI no longer needs `MISSION_ROLE=mission_controller`. A policy denial is reported as `[MISSION_STATE_ACCESS_DENIED]` with a warning instead of "not found".
- **Customer room layout and wording** — every callout (receipt, state screens, our proposal, current decision, role banner) puts its text in the kit's `kb-callout__content` column, so cards no longer squeeze into narrow columns on phones. The role banner says that answers on "Needs your decision" items stay provisional until our representative confirms them, and the bolt-review question and background use "this round of work" instead of the internal word "bolt".
- **Customer decision WorkItems carry the mission's project** — the CD-09 rework WorkItem and the bolt-review agenda (and so its change-request WorkItem) take the mission's project id instead of `default`.
- **`customer-decision reminders --install --by user:<member>`** — `--by` is now required and is recorded as the asset ledger's `ingested_by`; the command no longer fails without `KYBERION_PERSONA` / `MISSION_ROLE`.
- **`pnpm mission finish` shows the bolt-review command as its closing line** — instead of logging it mid-run among the retrospective output.

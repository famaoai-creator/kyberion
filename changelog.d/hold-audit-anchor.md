---
category: Changed
---

- **Required human holds are now also recorded in the audit chain.** When `plan-tasks` (or mission start) plans a process template that has required holds, the holds are recorded as `mission.human_holds_anchored`. If the chain cannot take that record, planning stops before it writes anything.
  - `finish` and `gate-pass` (including `--machine-only`) add these holds to the ones read from the mission's own files. Rewriting the mission state, including its `mission_id`, or deleting gate definitions after planning no longer drops a hold.
  - `finish` is blocked, and `gate-pass` refuses with `HUMAN_HOLD_UNVERIFIABLE`, when the audit chain cannot be read.
  - `gate-pass` of a gate with no stored definition is refused while any other hold is pending. A hold whose gate definition is missing now reports `gate_definition_missing` first, with `plan-tasks` as the next step.
  - Missions planned before this change, and audit files already archived by retention, carry no anchor; those missions keep the file-based holds only.

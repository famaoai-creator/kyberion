---
category: Changed
---

- Mission state now records the mission's Org Role as `org_role` (formerly `assigned_persona`). States that still carry `assigned_persona` are read as `org_role` for one release and are rewritten with `org_role` on the next save. A mission's Org Role no longer sets the execution persona: a mission-bound process without an explicit persona runs as `worker`. `mission_controller status` labels the field "Org Role".

---
category: Added
---

- **Heuristics are scored when their mission finishes** — the mission retrospective now stamps each captured intuition from that mission with the mission's outcome and offers the ones that held up (score ≥ 0.75) to the memory-promotion queue, where a steward still has to ratify them. The retrospective report no longer shows `validated: 0` forever.
- **A budget stop now reaches the operator** — when a dot hits its daily token cap or its org's hard budget limit, an `ops_alert` is sent once per dot, reason and day instead of only a debug heartbeat.

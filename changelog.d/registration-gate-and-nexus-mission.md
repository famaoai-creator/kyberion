---
category: Fixed
---

- **CI `registration-tests` gate no longer runs near its timeout** — the 47-second mission-orchestration CD-09 decision-lock suite ran twice on every PR (core suite and this gate). It now runs only in the core suite, roughly halving the gate's wall time (240–276 s of a 300 s budget on loaded runners).
- **The nexus daemon no longer writes a fake mission** — on start it wrote `active/missions/MSN-SYSTEM-NEXUS-DISPATCH/mission-state.json` outside every tier, which made `entity-governance` fail locally and left a mission no lifecycle verb could see. `MSN-SYSTEM-NEXUS-DISPATCH` remains only as the identity for the daemon's secret grants and its children's `MISSION_ID`. Delete a leftover `active/missions/MSN-SYSTEM-NEXUS-DISPATCH/` directory by hand.

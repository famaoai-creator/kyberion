---
category: Fixed
---

- **`mission finish` keeps the hand-written retrospective** — the retrospective generator wrote its execution stats and improvement proposals over `evidence/retrospective.md`, replacing the retrospective task's recorded deliverable. It now writes `evidence/retrospective-stats.md` (alongside the unchanged `evidence/retrospective.json`) and never creates or modifies `evidence/retrospective.md`. Look for the generated report under the new name; `pnpm mission retrospective <ID>` prints its path as `report_path`.

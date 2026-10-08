---
category: Fixed
---

- **`mission finish` keeps the hand-written retrospective** — the retrospective generator wrote its execution stats and improvement proposals over `evidence/retrospective.md`, replacing the retrospective task's recorded deliverable. It now writes `evidence/retrospective-stats.md` (alongside the unchanged `evidence/retrospective.json`) and never creates or modifies `evidence/retrospective.md`. Look for the generated report under the new name; `pnpm mission retrospective <ID>` prints its path as `report_path`.
- **`post-release-retrospective` pipeline template no longer truncates the retrospective** — it wrote its artifact checklist to `evidence/retrospective.md` with a shell redirect, under an untiered `active/missions/<ID>` path. It now writes `evidence/retrospective-packet.md` under the engine-derived mission evidence directory; `evidence/retrospective.md` stays the team's hand-written deliverable.

---
category: Changed
---

- The work-item board shows Issues (top-level WorkItems): each card carries its step progress ("2 of 5 steps done") and opens its steps inside the card; a text search still finds a step on its own. A step's detail page shows its Issue in the breadcrumbs, and an Issue's page lists its steps. A mission's ownership item reads as the mission. `workspace.list` accepts `top_level=true` and `parent_item_id`.
- A parent Issue's status now follows its steps — for example, when every step is done the Issue moves to review. It never reopens a done or archived Issue, never changes a claimed one, and a status a person set directly on an Issue with steps stays until it is handed back with `pnpm work update-status --item-id <id> --status-from-children`. The rules are listed in the GLOSSARY (WorkItem).
- `pnpm work list-board --board-id <id>` lists Issues with their step progress (`--all-items` lists the steps too); `pnpm work list-items` accepts `--top-level` and `--parent-id`.

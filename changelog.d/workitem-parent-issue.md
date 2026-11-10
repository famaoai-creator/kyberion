---
category: Added
---

- WorkItems can now belong to a parent Issue (`parent_item_id`). Mission task WorkItems are created as children of the mission's ownership item, and a dot action that targets an existing WorkItem becomes its child; discussion outcomes stay top-level Issues. A parent must exist, share the child's tenant, and never form a cycle. `listWorkItems` accepts `topLevelOnly` and `parentItemId`. Backfill existing mission task items with `pnpm work migrate-parents` (dry run) and `pnpm work migrate-parents --apply`.

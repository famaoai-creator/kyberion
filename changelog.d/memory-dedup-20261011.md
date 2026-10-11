---
category: Fixed
---

- **Memory promotion queue duplicates** — distill and finish no longer append a second row for the same mission on the same day: enqueue merges on `candidate_id` + scope identity (keeping the retained summary hash-consistent), and finish reuses the distill-path candidate identity and scope.
- **Docs** — pre-PR checklist gains prettier-first ratchet and golden clean-tree triage rows; co-execution contract gains a shared-checkout live-verification section.

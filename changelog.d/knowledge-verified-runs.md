---
category: Added
---

- **Knowledge hints show whether their current text has worked.** Each delivered document is labelled `worked in a run on <date>`, `changed since it last worked — check the steps you rely on`, or `reported wrong/stale`. The label comes from a per-tenant ledger of successful runs. A run counts as successful when a mission task finishes without gaps or open needs and reports using that delivered document. A problem counts only when a person gives explicit `wrong` / `stale` feedback.
- **A procedure that changed since it last worked is delivered to its project's next missions mechanically.** One such document is added even when the mission's topic does not match it, until a run confirms the new text. It is never sent to other projects or tenants.
- **Old documents that keep working are no longer reported as stale.** The weekly curation report skips an age-based `stale` breach when the document's current text worked in a run within the freshness window. `review_by` deadlines and missing `last_updated` are still reported.

---
category: Fixed
---

- **A failed follow-up write no longer re-runs a dot wake** — when `dot_schedule_followup` cannot persist after the wake's proposals were governed, the wake is still recorded delivered and the failure lands in the receipt's `tool_errors` (plus a warn). The trigger is not retried, so tokens are not spent twice, proposals are not re-dispatched, and memory adds are not re-applied. A torn line in `followups.jsonl` is skipped with a warning; it no longer blocks every later follow-up, and the check against re-arming an existing successor still applies.
- **One torn dot-inbox row no longer blocks idempotent reports** — the delivery-receipt lookup skips unparseable rows and only scans the newest 4 MiB of the shared inbox.
- **Duplicate dot_ids no longer take the original dot offline** — a repo-level charter keeps its id over tenant duplicates. Among tenants, the single `active`/`paused` charter keeps its id over draft or retired duplicates. Duplicates within one scope, or with no single owner, are all rejected. Rejected duplicates are still reported, and `findDotCharter`, lifecycle transitions and `dot validate --gate` resolve to the owner.

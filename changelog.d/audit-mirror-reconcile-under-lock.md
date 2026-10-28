---
category: Security
---

- `audit mirror-reconcile --apply` now acts only on the findings that were approved. It holds the approval's record lock and then the audit chain's append lock (the order revoke uses) from a final findings recheck through the archive and rebuild. If a mirror changed after the approval check, the apply stops with `AUDIT_MIRROR_CHANGED` before it uses the approval or moves anything. No audit append can land while it archives and rebuilds, and a revoke that races the apply is refused with its reason instead of a lock timeout. The master chain is parsed once under the lock. Audit writers wait for the lock (up to 5 seconds) while an apply runs; collecting findings over a 30 MB chain takes about a quarter of a second.
- New `consumeApprovalWithin` (approval-revocation): consumes an approval at a point the caller chooses inside its record lock. `markApprovalConsumed` is built on it.

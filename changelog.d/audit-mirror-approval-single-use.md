---
category: Security
---

- An `audit mirror-reconcile --apply` approval is now used once. The apply records it as consumed (consumer `audit_mirror_reconcile`, with the archive directory as its effect) before it archives anything, so a second apply with the same approval is refused even when the same drift recurs with identical findings. Two applies racing on one approval cannot both run. If an apply fails partway, request a new approval rather than retrying the old one.

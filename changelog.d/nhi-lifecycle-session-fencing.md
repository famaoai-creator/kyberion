---
category: Security
---

- NHI session admission now fences lifecycle and accountability changes under the identity-journal writer lease. Suspension and accountable-human transfer invalidate admitted sessions, including after reactivation or transfer back. Stop all identity writers and upgrade/restart them together; mixed-version operation and rollback to old writers are unsupported. Stale or legacy approvals require fresh review. Incomplete admissions retain their claims for reconciliation rather than silently retrying or returning invalid tokens.

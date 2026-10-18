---
category: Security
---

- **deny_read hardening and auto-reply ledger growth** — role `deny_read` carve-outs now match case-insensitively and on the resolved path (case-insensitive volumes, `..`, symlinked spellings), and also apply on the partitioned runtime-ledger branch. Capped or budget-exhausted peer auto replies record at most one `skipped` row per (sender, session, reason) per hour.

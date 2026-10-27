---
category: Fixed
---

- **One junk audit line no longer forks or hides the audit chain** — the audit-chain writer and its readers (`loadAll`, tenant mirror checks) read day files line by line, so a new record links to the last readable entry instead of restarting from an earlier day, and `audit:verify` reports the junk line itself (`<file>:line:N:invalid_record`). An append after a tail without a trailing newline (a torn write or a planted fragment) starts a new line instead of being swallowed into the fragment, in the master chain and the tenant mirrors.
- **Unreadable tenant mirror lines are reconcilable** — `verifyTenantMirrors` reports them as `tenant_mirror_unreadable`, and `audit_mirror_reconcile` turns them into a `mirror_unreadable` finding (`quarantine_and_rebuild`, with `unreadable_lines`) instead of throwing; it reads a non-default master as leniently as `loadAll`.

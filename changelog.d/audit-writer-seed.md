---
category: Fixed
---

- **One junk audit line no longer forks the audit chain** — the audit-chain writer and every reader (`loadAll`, tenant mirror checks) read day files line by line: a new record links to the last readable entry instead of restarting from an earlier day when one line is unparseable, `audit:verify` reports the junk line itself (`<file>:line:N:invalid_record`), and an unparseable tenant mirror line is a `tenant_mirror_unreadable` finding.

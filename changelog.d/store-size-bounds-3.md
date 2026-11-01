---
category: Added
---

- The system and tenant audit ledgers rotate into dated segments at 64 MiB without breaking the hash chain: each new live file opens with a signed entry linking to the previous segment, and `audit:verify`, scoped reads and tenant backup/restore cover every segment (a broken boundary or missing middle segment is reported by name).
- The iMessage bridge event log rotates at 8 MiB; segments are archived (never deleted) after 90 days.
- Per-tenant autonomy-outcomes files are trimmed to their learning window at write time; the tenant store capability admits only that store's own rewrite files and archive.
- `pnpm kyberion storage recover-compaction-copies` lists leftover `.compacting-*` copies from failed rewrites and, with an approved `--apply`, merges them back into the live store under its lock (identical lines from earlier files are dropped) and removes them; ops-health findings name the command.

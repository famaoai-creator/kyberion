---
category: Added
---

- **Operator notification inbox fallback** — `pnpm kyberion notify --set inbox` routes workflow events (approvals, questions, ops alerts) into the local deliverable inbox; no chat bridge required. `pnpm kyberion` shows the unread count and `pnpm kyberion inbox` lists/acknowledges them.
- **Fixed** — `pnpm kyberion notify --set` no longer fails with "Sovereign Sanctuary" (personal-tier write now runs under the governed concierge role), and notification preferences load correctly for non-personal-tier callers, so configured channels actually deliver.
- **Fixed** — the storage janitor now prunes expired empty directories under `active/shared/tmp/` instead of only deleting files.

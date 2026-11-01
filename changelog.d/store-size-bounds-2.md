---
category: Fixed
---

- The remaining runtime stores no longer fail a read on size: dot feedback, signal, token-usage, inbox and digest ledgers; mesh deliveries and dead letters; peer task-exchange, reply-jobs, inbox and outbox; co-session presence, handoffs and events; work-coordination items, leases and events; agent-input-queue; the ingest content-hash registry; the vulnerability ledger; metrics; runtime health; PR and mandate shadow ledgers. Readers stream or scan back to their window.
- Retention runs at write time for these stores: windows for dot feedback (37 days, archived), token usage (3 days, archived, so the daily token cap cannot be bypassed), dot signals, runtime health and autonomy outcomes; latest-per-key compaction for mesh deliveries, peer task and reply jobs, co-session presence and work-coordination (version-1 work-item snapshots are kept, replacing the old non-atomic 64 MB inline fold). Autonomy outcomes are no longer rotated, so promote/demote evidence inside the learning window survives.
- `JsonlTail` and `readJsonLinesCached` no longer throw on large backlogs: they read in chunks, warn once, and keep advancing (a nerve-bridge subscription used to stall forever).
- New `runtime-store-whole-read` ratchet gate blocks new whole-file reads of JSONL stores; ops-health now measures JSONL files inside `review_required` runtime directories, and a rotate entry without a threshold uses the janitor default instead of never warning.
- An agent-input-queue entry consumed or cancelled more than 30 days ago may report `already_cleared` instead of `already_consumed` once the queue passes 1 MiB.

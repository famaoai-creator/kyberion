---
category: Fixed
---

- A runtime store's size no longer makes a read or an append fail. New size-independent JSONL readers (`libs/core/jsonl-read.ts`: last line, backward scan, forward stream) and shared write-time retention (`libs/core/append-only-store.ts`: rotate, compact by key, time window) that the janitor now also uses; the janitor can compact stores larger than 100 MB.
- The trigger delivery journal has no 5 MB append cap or 8 MB read window: dedupe scans backward over the 7-day window, and growth is the warn-level ops-health finding `trigger-store-growth` (was `trigger-store-near-cap`).
- Ledger and audit-chain appends no longer re-read the whole file; an unreadable newest audit day refuses the append instead of silently forking the chain from an older file. Verification streams.
- The stimuli journal drops its 5 MB / 11 MB caps; mesh presence compacts to the latest heartbeat per peer; mesh, dot action ledger and mission queue readers stream without a cap; the mission queue drops terminal rows older than 14 days.

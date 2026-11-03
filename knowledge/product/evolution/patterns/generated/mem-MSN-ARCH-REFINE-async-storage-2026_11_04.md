---
title: StorageBackend seam is async; sync adapters wrap once
tags: [architecture, storage, seam, async]
last_updated: 2026-11-04
---

# StorageBackend seam is async; sync adapters wrap once

The governed `storage-backend` seam resolves `AsyncStorageBackend`. Sync
implementations (`local-fs`, `memory`) register through
`toAsyncStorageBackend` / `registerStorageBackend` so every caller `await`s
durability. `EntryLedger` and ingest asset ledger APIs are async for the same
reason — do not add a parallel sync I/O path for cloud stores.

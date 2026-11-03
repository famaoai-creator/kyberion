### Features

- **storage-backend** is now an async seam (`AsyncStorageBackend`): sync adapters (`local-fs`, `memory`) wrap through `toAsyncStorageBackend`, and `EntryLedger` / ingest asset ledger APIs await durability so Promise-based object stores can land without silent fire-and-forget writes.

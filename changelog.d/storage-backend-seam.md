---
category: Added
---

- **storage-backend seam** — `libs/core/storage/` adds the `StorageBackend` contract (sync POSIX subset) on a named provider-registry seam. `local-fs` is the governed default (secure-io semantics unchanged); `createMemoryStorageBackend()` gives hermetic ledgers for tests via `createEntryLedger(path, { backend })`. Selection order is governed data (`seam-provider-selection/storage-backend.json`), so object-storage backends can land as providers without touching call sites.

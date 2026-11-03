---
category: Added
---

- **lease-backend seam** — `libs/core/lease/` adds the `LeaseBackend` contract (mutex + fenced lease record IO) on a named provider-registry seam. `local-file-lock` is the governed default (identical locking and secure-io semantics as before); `createMemoryLeaseBackend()` gives hermetic writer-lease tests via `withFencedWriterLease{,Sync}({ backend })`. Selection order is governed data (`seam-provider-selection/lease-backend.json`), so distributed lease providers (Redis/KV-style) can land without touching call sites.

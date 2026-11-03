---
category: Changed
---

- **mission-lease async API** — `acquireLeaseAsync` / `renewLeaseAsync` / `releaseLeaseAsync` (and async introspection) serialize through `LeaseBackend.withLock`, so distributed providers like `kv-lock-stub` work without a sync mutex.

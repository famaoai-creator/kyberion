---
category: Added
---

- **lease-backend `kv-lock-stub`** — Redis/KV contract double for multi-node exclusion (`createKvLeaseBackendStub` / shared store). Async `withLock` only; `withLockSync` refuses so distributed callers cannot pretend a blocking sync mutex exists. Never auto-selected.

---
category: Fixed
---

- **Shared file locks self-recover again** — lock records under `active/shared/runtime/locks/` are now published atomically (temp file + hard link), so a crash or power loss can no longer leave an empty or partial record at the lock path. Unverifiable records and orphaned `.reclaim` cleanup guards (including reused-PID guards) are reclaimed automatically once older than 30 s, still serialized through the guard. `acquireLock` again returns `false` on timeout instead of throwing; `withLockSync`/`withLock` keep `[LOCK_TIMEOUT]` (the sync message names a pending recovery). Use `inspectLockRecovery(resourceId)` to see why a lock is waiting. No operator action is needed.

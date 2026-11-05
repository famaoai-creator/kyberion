---
category: Added
---

- Delegations now return a structured `DelegationResult` through `DelegationHandle.joinResult()` (`completed` / `failed` / `incomplete` / `cancelled`, failure class from the existing reasoning failure taxonomy, artifact references, measured-only usage, secrets masked); the delegated task record persists it as `outcome`. `join()` keeps returning text.
- `delegateTask` accepts an optional `idempotencyKey` (`deriveDelegationIdempotencyKey({ workItemId, attempt })`): the same key and payload runs once — concurrent calls join and later calls replay the stored result — while a changed payload under the same key is rejected as a typed conflict. Reservations live under `active/shared/runtime/delegation-idempotency/`.
- The failover chain no longer re-runs a delegation on another candidate (or retries it in place) once its execution has started; such failures report `allowFailover: false`. Work-item claim replay also compares an optional payload hash.

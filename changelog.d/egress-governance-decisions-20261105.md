---
category: Security
---

- **`approved_providers` no longer counts as no-training evidence** — a reasoning send of tenant or personal material declared `training_use: no_training` is now denied when the provider egress policy allows it only through a `tier_policy.<tier>.approved_providers` exception. Declare `providers.<id>.training_use: none` in `provider-egress-policy.json` or record a custody attestation (`pnpm onboarding llm attest ... --request-approval`). Delegation (`checkProviderEgress`) still honours the exception.
- **Aborted delegations keep their concurrency slot until the child has stopped** — on abort or wall-clock expiry the dispatcher (`AgentDispatcher`) now waits, bounded by 2 × `KYBERION_DELEGATION_KILL_GRACE_MS` + 1s, for the provider adapter to finish its SIGTERM → SIGKILL stop before rejecting, so the next delegation cannot start while the previous child is still running. The rejection carries the adapter's `child_exit=…` observation, or `child_exit=unconfirmed` after the bound. Callers that must return immediately pass `delegation_abort_wait: 'immediate'`.

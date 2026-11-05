---
category: Security
---

- **`approved_providers` no longer counts as no-training evidence** — a reasoning send of tenant or personal material declared `training_use: no_training` is now denied when the provider egress policy allows it only through a `tier_policy.<tier>.approved_providers` exception. Declare `providers.<id>.training_use: none` in `provider-egress-policy.json` or record a custody attestation (`pnpm onboarding llm attest ... --request-approval`). Delegation (`checkProviderEgress`) still honours the exception.

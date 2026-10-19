---
category: Changed
---

- **Reasoning sends honour tenant provider attestations for non-training** — a payload scope declaring `training_use: 'no_training'` toward an external backend is denied unless the scope's tenant holds a valid, unexpired `training_use: none` attestation for the backend's egress provider (read through the same governed lookup as `checkProviderEgress`, `lookupTenantProviderAttestation`). Confidential/personal tier and tenant domain policy still apply afterwards; no, expired, other-tenant or non-`none` attestations keep the denial. A backend without an `egress_provider_id` (e.g. the `anthropic` API descriptor) stays denied. `zero_retention` is no longer an accepted synonym for non-training: a remote retention guarantee needs its own evidence, so `zero_retention` now fails closed instead of passing on a non-training attestation — callers that meant "the provider does not train on this" declare `no_training`.

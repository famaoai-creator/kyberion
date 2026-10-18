---
category: Changed
---

- **Reasoning sends honour tenant provider attestations for `zero_retention`** — a payload scope declaring `training_use: 'zero_retention'` toward an external backend was always denied, because `assertReasoningEgressAllowed` never read the attestations `pnpm onboarding llm attest` / `pnpm tenant attest-provider` record. It now allows the send when the scope's tenant holds a valid, unexpired `training_use: none` attestation for the backend's egress provider (read through the same governed lookup as `checkProviderEgress`, new `lookupTenantProviderAttestation`). Confidential/personal tier and tenant domain policy still apply afterwards; no, expired, other-tenant or non-`none` attestations keep the denial. A backend without an `egress_provider_id` (e.g. the `anthropic` API descriptor) stays denied.

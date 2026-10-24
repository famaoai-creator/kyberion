---
category: Added
---

- **Delegable provider attestation** — `tenant:attest_provider` is now a delegable external operation: a human-signed charter grant naming the exact claim lets the installed agent apply `training_use: none` attestations (including renewals) without a per-instance approval; `pnpm onboarding llm attest` prints the exact `delegation_grant` and the `pnpm onboarding authority` flow to sign it.

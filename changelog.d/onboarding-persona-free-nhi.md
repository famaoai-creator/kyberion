---
category: Fixed
---

- **Onboarding no longer needs an exported operator persona** — `pnpm onboarding company`, `pnpm tenant:activation` and `pnpm onboarding:context` now run under the governed onboarding authority `pnpm tenant` already uses, so the AI-company route works from a fresh shell. Only `pnpm organization` writes still need `KYBERION_PERSONA=sovereign` (or a tenant-scoped `organization_operator`).
- **New companies can pass the NHI activation probe** — `pnpm onboarding company` issues the declared AI worker's NHI (`kyberion://agent/<slug>/ceo-operator`) with its accountable human, returns it as `workerNhiId`, and its next steps run `pnpm tenant:activation probe` with that id. A brand-new organization no longer needs an external attestation for `nhi_provisioned`.

---
category: Changed
---

- **`_` in the tenant position of an NHI id formally means "no tenant"** — identities that belong to no tenant (person-scope onboarding agents, runtimes started without a tenant) keep `kyberion://agent/_/_/<slug>`; `_` is never a tenant slug. Documented in the GLOSSARY, NHI_IDENTITY_MAPPING and `contracts/nhi-id.ts` (no behavior change).

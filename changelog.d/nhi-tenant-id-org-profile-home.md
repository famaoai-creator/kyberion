---
category: Changed
---

- **NHI ids carry the tenant** (concept model v2 D3) — new ids are `kyberion://agent/<tenant>/<org|_>/<slug>`; the tenant is required (a reserved scope name is rejected), `_` means the NHI belongs to no organization in its tenant, and the `'default'` organization fallback is gone. An identity with no tenant (person-scope onboarding agents, runtimes started with no tenant in scope) is `kyberion://agent/_/_/<slug>` for now. `pnpm nhi issue` now requires `--tenant-slug` (or `--person-scope`).
- **Migration required** — run `pnpm nhi migrate-ids` (dry run) and then `pnpm nhi migrate-ids --apply` to move NHI ledger records from `kyberion://agent/<org>/<slug>` to the new ids; re-running is a no-op. Old ids resolve as aliases for one release and log a deprecation warning once per id. Run `pnpm migration` to move each tenant's `knowledge/confidential/{tenant}/organization-profile.json` to `knowledge/confidential/{tenant}/organizations/{org}/organization-profile.json` (`0004-organization-profile-home`); until then the loader reads the old location with a one-time warning.
- **Organization profiles are per organization** — company onboarding and bootstrap write the profile to the company's organization under the tenant home, and `resolveCompany` reads it through the same resolver as every other reader (Company is an alias of Tenant, with no separate store).

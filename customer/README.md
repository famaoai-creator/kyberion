# Legacy `customer/` directory

This directory used to hold three different things under one slug. They are
being separated (store-catalog guard design, S1–S3 —
[design](../docs/developer/improvement-plans-2026-11/STORE_CATALOG_GRANT_GUARD_DESIGN_2026-11-05.ja.md)):

| What                                                                                                                                                                      | Where it lives now                                                        | Status                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Stance** — which hat you wear                                                                                                                                           | `knowledge/personal/stances/{slug}/` (template `templates/stance/`)       | moved (S1)                                                             |
| **Tenant company assets** — company descriptor (`company.json`), organization profile, vision, org chart, OKRs, decision rights, finance, brand, design, channel bindings | `knowledge/confidential/{tenant}/` (template `templates/tenant-company/`) | moved (S2)                                                             |
| **Tenant audit mirror**                                                                                                                                                   | `active/shared/runtime/audit-mirror/confidential/{tenant}/`               | moved (S2)                                                             |
| **Tenant's customer records** — deals, requirements, escalations, conversations                                                                                           | still here, as `customer/{tenant}/deals/`                                 | moves in S3 to `knowledge/confidential/{tenant}/customers/{customer}/` |

## Stances

Create, inspect and select a stance:

```bash
pnpm stance:create acme-corp        # copies templates/stance/
pnpm stance:list                    # stance.json / identity.json files are present?
pnpm stance:switch acme-corp        # writes active/shared/runtime/stance.env
source active/shared/runtime/stance.env   # sets KYBERION_STANCE
```

`KYBERION_CUSTOMER` is the deprecated name of `KYBERION_STANCE` and is still read
with a warning.

## Migrating an existing install

`pnpm migration --dry-run` lists every move; `pnpm migration` applies them.
Migration `0001-stance-home` moves the stance entries, `0002-tenant-home` the
company assets (`customer.json` becomes `company.json`) and the audit mirror.
Existing targets are never overwritten. Only customer records stay here until S3.

See [stance-tenant-customer-model](../knowledge/product/architecture/stance-tenant-customer-model.md)
for the three layers.

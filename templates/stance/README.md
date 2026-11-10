# Stance template

A **stance** is the acting-for selection: which tenant you are acting for right
now, as which Organization and Org Role (`acting_for` in `stance.json`). It is
chosen from the tenants you are permitted to serve — the active profiles in
`knowledge/personal/tenants/` — and switching it switches the data scope. The
stance directory also carries the identity, connections, approval policy, voice
and mission seeds you use while acting for that tenant. It is your configuration
(custody `person`), so it lives in your personal space and overlays
`knowledge/personal/`:

```
knowledge/personal/stances/{slug}/{file}  →  knowledge/personal/{file}
```

Create one with `pnpm stance:create <slug>` (copies this template), select it
with `pnpm stance:switch <slug>` and `source active/shared/runtime/stance.env`
(sets `KYBERION_STANCE`, and `KYBERION_TENANT` / `KYBERION_ORGANIZATION_ID`
from `acting_for`). `pnpm stance:switch` rejects a stance whose tenant you are
not permitted to serve. The template ships without `acting_for`; add it:

```json
"acting_for": { "tenant_slug": "acme", "organization_id": "delivery", "org_role": "solution_architect" }
```

| Entry            | What to put                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `stance.json`    | Slug, display name, kind (`engagement` or `affiliation`) and `acting_for` (tenant, Org, Org Role). |
| `identity.json`  | The identity Kyberion uses under this stance (mirrors `knowledge/personal/my-identity.json`).      |
| `connections/`   | Service connections used under this stance.                                                        |
| `policy/`        | Approval and risk policy overrides.                                                                |
| `voice/`         | Your own voice profile overrides (not how the tenant talks to its customers).                      |
| `mission-seeds/` | Mission seeds offered under this stance.                                                           |
| `tenants/`       | Tenant profiles this stance may act for.                                                           |

A stance holds no company assets, no customer records and no customer
communication settings. The company assets of a tenant (profile, vision, org
chart, brand), its customers' records and how it talks to them (channel
bindings with language and mode, each customer actor's contact channel) belong
to the tenant under `knowledge/confidential/{tenant}/` — see
`templates/tenant-company/` and
[stance-tenant-customer-model](../../knowledge/product/architecture/stance-tenant-customer-model.md).

## Commands

```bash
pnpm stance:create acme-corp        # copies this template to knowledge/personal/stances/{slug}/
pnpm stance:list                    # stance.json / identity.json files are present?
pnpm stance:switch acme-corp        # writes active/shared/runtime/stance.env
source active/shared/runtime/stance.env   # sets KYBERION_STANCE
```

`KYBERION_CUSTOMER` is retired. For one release it is still read as the stance
slug when `KYBERION_STANCE` is unset and that stance directory exists (otherwise
ignored), always with a deprecation warning — set `KYBERION_STANCE` instead.

## Migrating an install that still has `customer/`

Stances, company assets and customer records used to share a top-level
`customer/{slug}/` directory. `pnpm migration --dry-run` lists every move and
`pnpm migration` applies them: `0001-stance-home` moves the stances,
`0002-tenant-home` the company assets (`customer.json` becomes `company.json`)
and the audit mirror, `0003-deal-home` the deals; an emptied `customer/` is
removed. Existing targets are never overwritten.

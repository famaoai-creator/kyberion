# Stance Use Cases (`knowledge/personal/stances/{slug}/`)

Anyone who acts for more than one tenant — typically an FDE or
implementation-support engineer serving several customers — needs a repeatable
way to say which one they are acting for right now, with the same checkout. A
**stance** is that selection: which permitted tenant you act for, as which
Organization and Org Role (`acting_for` in `stance.json`). Switching it switches
the data scope. The stance directory also carries your own configuration for
that engagement (identity, connections, policy, voice, mission seeds). This was
once called the "customer overlay"; that name and `KYBERION_CUSTOMER` are
retired.

## The story

1. An FDE starts with one Kyberion checkout and a tenant profile for each customer they serve (`knowledge/personal/tenants/`).
2. For each engagement, they create a stance from the template and declare `acting_for` (tenant, Org, Org Role).
3. They migrate any existing personal setup if the engagement is based on an already-used local environment.
4. They inspect which stances are present and whether the required files are filled in.
5. They switch to the stance only after it is ready; a tenant they are not permitted to serve is rejected.
6. They run onboarding and doctor checks so the environment is ready for work.
7. They add engagement-specific identity, connections, policy, voice, and mission seeds inside the stance.
8. They use Kyberion for that tenant until the engagement ends.
9. They switch to the next stance or fall back to the personal environment.

## Use cases

| #   | Use case                       | What the user does                                                                                            | Expected outcome                                                             |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Start a new engagement         | `pnpm stance:create <slug>`, then add `acting_for` to `stance.json`                                           | Creates `knowledge/personal/stances/<slug>/` from `templates/stance/`        |
| 2   | Reuse an existing local setup  | `pnpm stance:migrate-from-personal <slug>`                                                                    | Copies personal files into the stance                                        |
| 3   | Inspect engagement readiness   | `pnpm stance:list`                                                                                            | Shows which stances exist and which required files are missing               |
| 4   | Act for a tenant               | `pnpm stance:switch <slug>`                                                                                   | Writes `active/shared/runtime/stance.env` binding the stance, tenant and Org |
| 5   | Boot the engagement            | `pnpm onboarding`                                                                                             | Creates or updates stance-scoped onboarding state                            |
| 6   | Check the environment          | `pnpm kyberion doctor`                                                                                        | Summarizes must / should / nice readiness signals                            |
| 7   | Fill engagement-specific setup | Edit `knowledge/personal/stances/<slug>/identity.json`, `connections/`, `policy/`, `voice/`, `mission-seeds/` | Stance config overrides the personal fallback                                |
| 8   | Run the work                   | Use the normal Kyberion commands and workflows                                                                | Data access is scoped to the tenant the stance acts for                      |
| 9   | Move to another engagement     | Switch to another slug and repeat the checks                                                                  | Tenant data stays isolated between engagements                               |
| 10  | Return to personal use         | Unset `KYBERION_STANCE` (and `KYBERION_TENANT` / `KYBERION_ORGANIZATION_ID`)                                  | Kyberion falls back to `knowledge/personal/`                                 |

## What this protects

- Acting for tenant A never reads tenant B's data: the stance binds one tenant, and only one you are permitted to serve.
- Engagement A's connections do not leak into engagement B.
- The operator can keep one repo checkout and still separate deployments.
- Readiness is visible before a stance is switched on.
- Existing personal workflows still work when no stance is active.

## What this is _not_

A stance selects a data boundary; it is not one. Three things that sound like
they belong in it live elsewhere:

- **Confidential data** belongs to a **tenant**, at
  `knowledge/confidential/{tenant-slug}/`. Switching stance changes which tenant
  is in view; it never creates a confidentiality boundary of its own, never
  widens beyond the tenants you are permitted to serve, and cross-tenant access
  stays deny-unless-brokered and audited.
- **How the tenant talks to its customers** — language, conversation mode and
  contact channel — is tenant data: the channel bindings in
  `knowledge/confidential/{tenant-slug}/connections/channel-bindings.json` and
  the customer actors under `knowledge/confidential/{tenant-slug}/customers/`.
- **A tenant's own end customers** belong inside that tenant, at
  `knowledge/confidential/{tenant-slug}/customers/` — not under
  `knowledge/personal/stances/{slug}/`, which would put them outside the boundary meant to contain
  them.

Full distinction: [stance / tenant / a tenant's customers](../../knowledge/product/architecture/stance-tenant-customer-model.md).

## Related docs

- [Stance / Tenant / Customer — the three layers](../../knowledge/product/architecture/stance-tenant-customer-model.md)
- [Customer Aggregation Point](../developer/CUSTOMER_AGGREGATION.md)
- [Customer Aggregation Point (JA)](../developer/CUSTOMER_AGGREGATION.ja.md)
- [templates/stance/README.md](../../templates/stance/README.md)
- [Quickstart](../QUICKSTART.md)

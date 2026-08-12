# Stance Overlay Use Cases (`customer/{slug}/`)

Anyone who operates Kyberion as more than one entity needs a repeatable way to
keep each one isolated while using the same checkout. The overlay holds the
**stance** you operate from — which entity you are acting as right now. A
customer engagement is the case this was built for and the reason the directory
is named `customer/`; holding concurrent roles at several independent legal
entities is an equally valid use, and the story below reads the same with
"affiliation" substituted for "customer".

This document describes the customer-overlay story from the operator's point of
view: create a customer workspace, inspect its readiness, activate it, run the
regular onboarding and health checks, then switch to the next customer without
mixing state.

## The story

1. An FDE or implementation-support engineer starts with one Kyberion checkout.
2. For each customer engagement, they create a customer overlay from the template.
3. They migrate any existing personal setup if the engagement is based on an
   already-used local environment.
4. They inspect which customer overlays are present and whether the required files are filled in.
5. They switch the active customer only after the overlay is ready.
6. They run onboarding and doctor checks so the environment is ready for work.
7. They add customer-specific identity, vision, connections, policy, voice, and mission seeds inside the customer overlay.
8. They use Kyberion for that customer until the engagement ends.
9. They switch to the next customer or fall back to the personal environment.

## Use cases

| #   | Use case                        | What the user does                                                                                       | Expected outcome                                                |
| --- | ------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | Start a new customer engagement | `pnpm customer:create <slug>`                                                                            | Creates `customer/<slug>/` from `customer/_template/`           |
| 2   | Reuse an existing local setup   | `pnpm customer:migrate-from-personal <slug>`                                                             | Copies personal files into the customer overlay                 |
| 3   | Inspect engagement readiness    | `pnpm customer:list`                                                                                     | Shows which overlays exist and which required files are missing |
| 4   | Activate a customer             | `pnpm customer:switch <slug>`                                                                            | Writes `active/shared/runtime/customer.env` for a ready overlay |
| 5   | Boot the engagement             | `pnpm onboard`                                                                                           | Creates or updates customer-scoped onboarding state             |
| 6   | Check the environment           | `pnpm doctor`                                                                                            | Summarizes must / should / nice readiness signals               |
| 7   | Fill customer-specific setup    | Edit `customer/<slug>/identity.json`, `vision.md`, `connections/`, `policy/`, `voice/`, `mission-seeds/` | Customer-specific config overrides the personal fallback        |
| 8   | Run customer work               | Use the normal Kyberion commands and workflows                                                           | Operations resolve against the active customer overlay          |
| 9   | Move to another customer        | Switch to another slug and repeat the checks                                                             | Customer state stays isolated between engagements               |
| 10  | Return to personal use          | Unset `KYBERION_CUSTOMER`                                                                                | Kyberion falls back to `knowledge/personal/`                    |

## What this protects

- Customer A's connections do not leak into customer B.
- The operator can keep one repo checkout and still separate deployments.
- Readiness is visible before the active customer is switched on.
- Existing personal workflows still work when no customer is active.

## What this is _not_

The overlay is runtime configuration, not a data boundary. Two things that sound
like it belong elsewhere:

- **Confidential data** belongs to a **tenant**, at
  `knowledge/confidential/{tenant-slug}/`. Switching stance changes which tenants
  are in view; it never creates a confidentiality boundary of its own, and
  cross-tenant access stays deny-unless-brokered and audited.
- **A tenant's own end customers** belong inside that tenant, at
  `knowledge/confidential/{tenant-slug}/customers/` — not under
  `customer/{slug}/`, which would put them outside the boundary meant to contain
  them.

Full distinction: [stance / tenant / a tenant's customers](../../knowledge/product/architecture/stance-tenant-customer-model.md).

## Related docs

- [Stance / Tenant / Customer — the three layers](../../knowledge/product/architecture/stance-tenant-customer-model.md)
- [Customer Aggregation Point](../developer/CUSTOMER_AGGREGATION.md)
- [Customer Aggregation Point (JA)](../developer/CUSTOMER_AGGREGATION.ja.md)
- [customer/README.md](../../customer/README.md)
- [Quickstart](../QUICKSTART.md)

# Customer Overlay Use Cases

Kyberion users who work across multiple customer engagements need a repeatable
way to keep each engagement isolated while still using the same checkout.

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

| # | Use case | What the user does | Expected outcome |
|---|---|---|---|
| 1 | Start a new customer engagement | `pnpm customer:create <slug>` | Creates `customer/<slug>/` from `customer/_template/` |
| 2 | Reuse an existing local setup | `pnpm customer:migrate-from-personal <slug>` | Copies personal files into the customer overlay |
| 3 | Inspect engagement readiness | `pnpm customer:list` | Shows which overlays exist and which required files are missing |
| 4 | Activate a customer | `pnpm customer:switch <slug>` | Writes `active/shared/runtime/customer.env` for a ready overlay |
| 5 | Boot the engagement | `pnpm onboard` | Creates or updates customer-scoped onboarding state |
| 6 | Check the environment | `pnpm doctor` | Summarizes must / should / nice readiness signals |
| 7 | Fill customer-specific setup | Edit `customer/<slug>/identity.json`, `vision.md`, `connections/`, `policy/`, `voice/`, `mission-seeds/` | Customer-specific config overrides the personal fallback |
| 8 | Run customer work | Use the normal Kyberion commands and workflows | Operations resolve against the active customer overlay |
| 9 | Move to another customer | Switch to another slug and repeat the checks | Customer state stays isolated between engagements |
| 10 | Return to personal use | Unset `KYBERION_CUSTOMER` | Kyberion falls back to `knowledge/personal/` |

## What this protects

- Customer A's connections do not leak into customer B.
- The operator can keep one repo checkout and still separate deployments.
- Readiness is visible before the active customer is switched on.
- Existing personal workflows still work when no customer is active.

## Related docs

- [Customer Aggregation Point](../developer/CUSTOMER_AGGREGATION.md)
- [Customer Aggregation Point (JA)](../developer/CUSTOMER_AGGREGATION.ja.md)
- [customer/README.md](../../customer/README.md)
- [Quickstart](../QUICKSTART.md)

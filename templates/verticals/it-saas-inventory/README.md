# Vertical Template: IT / SaaS Inventory

Recurring SaaS account inventory:

1. For each registered SaaS service, list active accounts, license plan, and renewal date.
2. Cross-reference with HR (active employees).
3. Flag: orphaned accounts, expiring licenses, over-provisioned plans.
4. Produce a report (markdown + structured JSON) for IT review.

Targets: small/mid IT teams, FinOps, security audits.

## Customer-specific inputs

| Input | Where to find it | Example |
|---|---|---|
| `SAAS_SERVICES` | List of services to audit | `["github", "slack", "notion", "1password", "miro"]` |
| `HR_SOURCE` | Source of truth for active employees | `connections/google-workspace.json` (Workspace directory) |
| `EXPIRY_HORIZON_DAYS` | How far ahead to flag expiring licenses | `60` |
| `REPORT_OUT_PATH` | Where to drop the report | `customer/{slug}/reports/saas-inventory-{YYYY-MM}.md` |

## What it produces

- `inventory.json` — flat list (service, account, status, plan, last_active, owner, renewal)
- `flags.json` — `{ orphaned: [...], expiring_soon: [...], over_provisioned: [...] }`
- `report.md` — human-readable summary

## Smoke test

```bash
KYBERION_REASONING_BACKEND=stub pnpm pipeline --input templates/verticals/it-saas-inventory/pipeline.json
```

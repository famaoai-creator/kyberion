# Tenant profiles for this stance

One JSON file per tenant that should be visible while this stance is active.
This directory overrides `knowledge/personal/tenants/` — see `tenantProfileDir()`
in `libs/core/tenant-registry.ts`.

A tenant profile is a **declaration that a confidentiality boundary exists**:
its slug, display name, status, the role you hold there, and where its knowledge
root is. It is not the data itself; the data lives under
`knowledge/confidential/{tenant_slug}/`.

Schema: `knowledge/product/schemas/tenant-profile.schema.json`.
Kyberion bootstraps a `default.json` profile for compatibility.

## What does _not_ go here

**A tenant's own customers.** If a tenant delivers to end customers, those
records belong inside that tenant's boundary, at
`knowledge/confidential/{tenant_slug}/customers/`, alongside its other substance
(`organization/`, `security/`, …).

Putting them here would place one tenant's customer records outside the boundary
that is meant to contain them — and when two tenants serve the same end customer,
it would merge records that each tenant holds under its own compliance posture.
Keeping them per-tenant is what stops that merge.

## Sharing across tenants

Cross-tenant access is deny-unless-brokered and always audited. For material that
is genuinely cleared for a group of tenants, define a group at
`knowledge/confidential/tenant-groups/{group}.json` and place the shared
artifacts under `knowledge/confidential/shared/{group}/...`. Everything else
crosses only through an explicit brokered access, which leaves an audit record.

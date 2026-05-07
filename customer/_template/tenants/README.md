# Customer Tenants

If the customer has internal multi-tenant separation (e.g. multiple subsidiaries, dev/staging/prod environments, business units), place one JSON file per tenant here.

Schema follows `knowledge/personal/tenants/*.json` and `knowledge/public/schemas/tenant-profile.schema.json`.

Kyberion bootstraps a `default.json` tenant profile for compatibility. Use explicit `tenant_slug` values for isolated customer/business-unit work.

For controlled confidential sharing across tenants, define a tenant group under `knowledge/confidential/tenant-groups/{group}.json` and place shared artifacts under `knowledge/confidential/shared/{group}/...`.

---
title: 'Service Integration and Connection Guide'
tags: [service, integration, connection, onboarding, security]
last_updated: 2026-10-05
runtime_stages: [alignment, contract_authoring, execution]
---

# Service Integration and Connection Guide

This is the canonical procedure for adding a service to Kyberion and for
connecting an existing service account. These are separate jobs: catalog
changes make a service callable; connection setup supplies credentials and
local configuration.

## First choose the direction

There are two different integration directions:

1. **Kyberion consumes an external service.** A Kyberion workflow calls a
   provider such as Slack, Google, or GitHub through `service-actuator`. This
   guide's endpoint/preset, OAuth/secret, egress, and tenant-binding steps cover
   this direction. `pnpm service:setup binding` creates Kyberion's tenant-owned
   connection/authority record for that use; it does not create a new external
   service or make Kyberion provide one.
2. **An organization provides a service to Kyberion.** Kyberion receives
   requests, events, or capabilities from an organization-owned system. This
   is an inbound integration: use the relevant bridge, satellite, surface, or
   actuator/tool contract, with its own authentication, ingress, and tenant
   authorization controls. A service endpoint/preset or tenant service binding
   alone does not register an inbound service.

If the integration is bidirectional, implement and validate both directions as
separate contracts.

## Choose the right integration surface

| Need                                                                      | Canonical path                                                                                                                            |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Call an external API, CLI, MCP server, OAuth flow, or SDK                 | Add a service endpoint and service preset under `knowledge/product/orchestration/`.                                                       |
| Manage a long-lived local process such as ComfyUI                         | Use the service runtime registry/lifecycle; endpoint and preset may also describe its operations.                                         |
| Receive or deliver messages through Slack, Discord, Telegram, or iMessage | Use the relevant satellite, surface, or presence channel. A service preset alone does not register a bridge or ingress route.             |
| Offer a URL template for search/weather/reference lookup                  | Extend `service-provider-catalog.json`; this is not an authenticated service integration.                                                 |
| Add a new kind of execution capability                                    | Check existing actuators first. If none fits, design and register an actuator rather than hiding new execution logic in a service preset. |

Check [`service-endpoints/README.md`](service-endpoints/README.md), existing
[`service-presets/`](service-presets/),
[`service-harness-registry.json`](service-harness-registry.json), and
[`CAPABILITIES_GUIDE.md`](../../../CAPABILITIES_GUIDE.md) first.

## Add a service to the catalog

1. **Confirm the gap.** Search existing endpoints/presets and aliases. Reuse
   the canonical service ID when the provider is already represented; do not
   duplicate an entry for another authentication method or account.
2. **Define the endpoint.** Add
   `knowledge/product/orchestration/service-endpoints/{service-id}.json` with
   exactly one service entry. The filename and service ID must match. Declare
   the same `default_pattern` as the existing endpoint entries, the canonical
   base URL (or preset path), `auth_strategy`, and any
   `credential_suffixes` or intent aliases required by the schema.
3. **Define operations.** Add
   `knowledge/product/orchestration/service-presets/{service-id}.json`.
   Follow `knowledge/product/schemas/service-presets.schema.json` and nearby
   presets. Declare transport and parameters. Mark capture vs apply, `risk`
   (`read` / `write` / `destructive`), `approval_required`, and `idempotency`
   explicitly wherever applicable. Reads must have no external effects. Writes
   and destructive operations must retain the approval gate.
   For a service whose operations always use tenant-owned connections, set
   top-level `tenant_binding_required: true` in the preset. For a mixed service,
   set it on each tenant-bound operation. At execution, Kyberion requires a
   matching trusted tenant scope and organization binding; when a project scope
   is present, the project must reference that binding. If any operation on a
   service requires a binding, undeclared/raw service actions are rejected so
   they cannot bypass the preset contract. In a mixed preset, declared
   operations without the binding flag can still run through PRESET without a
   tenant binding; the service cannot fall back to raw API/CLI/SDK/MCP modes.
4. **Keep credentials out of catalog files.** Presets may refer to a governed
   credential field, but never contain real tokens, passwords, or
   customer-specific connection data. Use placeholders and existing
   secret-guard conventions. Do not introduce arbitrary caller-controlled base
   URLs or commands that bypass service-engine network, CLI, approval, or scope
   boundaries.
5. **Regenerate derived catalogs.** Run
   `pnpm kyberion sync service-endpoints` to update the compatibility snapshot,
   then `pnpm kyberion generate service-harness-registry` to generate the
   harness catalog from service presets. Do not hand-edit generated snapshots.
6. **Validate the contract.** Run
   `pnpm check -- --scope full --only catalogs` and
   `pnpm check -- --scope full --only contract-schemas`, plus focused service-actuator or
   service-engine tests for operations, auth, approvals, and error cases. Run
   `pnpm service:setup` and `pnpm service:preflight -- --service <service-id>`
   when the current environment can exercise the connection. Report missing
   credentials separately from catalog validity.
7. **Document how to use it.** Record required scopes, authentication,
   optional CLI/runtime prerequisites, and limitations. If the service needs a
   bridge, runtime, onboarding prompt, or UI surface, register and validate
   that layer through its own governed catalog too. Add an entry to
   `service-onboarding-catalog.json` only when the wizard needs to collect
   non-secret connection settings; reuse a supported prompt kind or implement
   a typed flow for a new shape.

### Minimal example: token-authenticated read API

For a fictional `paper-notes` API with a bearer token and a read-only
`GET /v1/notes` operation, the endpoint file
`service-endpoints/paper-notes.json` can be:

```json
{
  "default_pattern": "https://api.{service_id}.com/v1",
  "services": {
    "paper-notes": {
      "base_url": "https://api.paper-notes.example/v1",
      "preset_path": "knowledge/product/orchestration/service-presets/paper-notes.json",
      "auth_strategy": "Bearer",
      "credential_suffixes": { "accessToken": ["API_TOKEN"] }
    }
  }
}
```

The matching preset `service-presets/paper-notes.json` can start with one
read-only operation:

```json
{
  "service_id": "paper-notes",
  "name": "Paper Notes API",
  "base_url": "https://api.paper-notes.example/v1",
  "auth_strategy": "Bearer",
  "operations": {
    "list_notes": {
      "type": "api",
      "kind": "capture",
      "risk": "read",
      "approval_required": false,
      "idempotency": "not_applicable",
      "method": "GET",
      "path": "notes",
      "description": "Lists notes visible to the authenticated account.",
      "parameters": {
        "limit": { "type": "integer", "required": false, "default": 50 }
      }
    }
  }
}
```

After saving the two source files, regenerate both derived catalogs, run the
catalog/schema checks above, then configure the token with
`pnpm kyberion secret introduce paper-notes API_TOKEN`. A token-only API does
not need an onboarding-catalog entry. Add operations only after their
parameters, pagination, output shape, and effect/risk behavior are known.

### Endpoint and preset distinction

`service-endpoints/{id}.json` declares which service is canonical and how its
endpoint/auth resolve. `service-presets/{id}.json` declares how to call it.
`service-harness-registry.json` is generated from operation contracts for
discovery and validation; it is not the authoring source.
`service-endpoints.json` is a compatibility snapshot, not the place to add a
service by hand.

## OAuth, egress, authority, and harness controls

These controls are conditional parts of integration work. Do not add broad
permissions just because a new service ID exists.

### OAuth

For OAuth 2.0, the preset also needs an `oauth` profile with the provider's
`authorize_url`, an explicit least-privilege `scopes` list, and operation names
for code exchange and (when supported) refresh. Implement those named
operations in the same preset using the provider's actual token endpoint,
payload, and response mapping. Kyberion's OAuth broker rejects scopes outside
the preset list. Keep PKCE enabled unless the provider cannot support it.
OAuth token revocation is not exposed by the current broker action surface; do
not document it as supported just because a `revoke_operation` field exists in
the profile type.

Register `CLIENT_ID` and `CLIENT_SECRET` with
`pnpm kyberion secret introduce <service-id> CLIENT_ID` and
`pnpm kyberion secret introduce <service-id> CLIENT_SECRET`; never add them to
the preset or a checked-in file. Then run the governed setup pipeline:

```bash
pnpm pipeline --input pipelines/setup-oauth.json --vars "service_name=<service-id>"
```

Register the callback URL shown by setup in the provider app. The default is
loopback `http://127.0.0.1:8787/oauth/callback`; configured overrides must
remain loopback HTTP and go through the interactive human setup path. OAuth
client credentials and granted user tokens are distinct secrets. After setup,
check the service with `pnpm service:setup` and
`pnpm service:preflight -- --service <service-id>`. See
[OAuth setup](../../../docs/OAUTH_SETUP.md) for the
operator walkthrough.

### Egress and authority

- The service endpoint's `base_url` host is included in Kyberion's general
  egress allowlist. If an operation or OAuth token exchange reaches another
  host, add that destination through the governed egress-policy change and
  validate it; do not use an arbitrary operation URL as a workaround.
- General egress permission does not authorize confidential or personal data
  to leave a tenant. If those tiers must reach the provider, the tenant needs a
  governed `tenant_allowed_domains` entry in the egress policy. Keep this
  tenant-specific and approval/audit mediated.
- Add a `service-authority-map.json` entry only when a mission grant for this
  service must contribute extra Kyberion authorities. List the minimum
  authority names required by the workflow; service IDs do not grant those
  authorities by themselves.
- The OAuth scope list is a separate provider-side authorization allowlist.
  Keep it to the operations being exposed and do not treat it as a replacement
  for Kyberion's tenant or mission authority checks.

### Harness and caller allowlists

`service-harness-registry.json` is generated from presets; do not hand-edit it
or add a service to a second global harness allowlist. The preset operations
are the service action inventory. Existing `kyberion.service.capture` is
capture-only and accepts only `kind=capture` plus `risk=read`; writes go through
`kyberion.service.actuate`, which is approval-gated and disabled by default.
If a new actuator, MCP tool, caller role, tier, or execution path is needed,
change its governed manifest/tool catalog and security policy separately, then
run the corresponding contract checks. If creating a reusable service
procedure, put only the exact required service/action IDs on that procedure's
allowlist and validate the procedure; a preset registration does not approve
arbitrary procedures.

## Connect an existing service

1. Run `pnpm service:setup` to see expected credentials, connection location,
   CLI alternatives, and runtime prerequisites.
2. Follow the provider's authorization flow and grant only scopes required by
   the operations. For CLI-backed integrations, authenticate the supported CLI
   as directed by that service's setup output.
3. For non-secret local settings supported by the onboarding catalog (such as
   a local base URL or CLI path), run:

   ```bash
   pnpm onboarding --services-only --service <service-id>
   ```

   This writes a scoped connection draft through onboarding. Review the saved
   profile connection through the governed setup/readiness commands; do not
   treat a draft marked `blocked` as ready. The wizard is limited to services
   declared in `service-onboarding-catalog.json`; it is not a general
   credential editor.

4. For a missing secret, use
   `pnpm kyberion secret introduce <service-id> <secret-key>`. The value is
   collected through the hidden prompt, or from a file under
   `active/shared/tmp/` with `--from-file`. Never put a secret on argv, in a
   prompt, mission evidence, pipeline input, log, or repository file. Follow
   the command's approval/apply instructions; local auto-approval still emits
   an audit record.
5. In the GUI, use Concierge **Settings → Service connections**; it uses the
   same governed secret-introduction flow. Do not edit connection JSON or
   `.env` directly.
6. Run `pnpm kyberion secret status <service-id>` to confirm registration
   without revealing the value. Immediately before use, run
   `pnpm service:preflight -- --service <service-id>`. Depending on the
   service, preflight may check CLI auth, a local runtime, or bridge health too.

Personal connections resolve through `knowledge/personal/`; a customer stance
selected by `KYBERION_CUSTOMER` uses its private `customer/{slug}/` overlay.
That overlay is a stance for connection/configuration resolution, not the
tenant containment scope. Tenant-scoped durable data belongs under
`knowledge/confidential/{tenant}/` and must follow the tenant registry and
governed tenant workflows. Never copy a personal/customer credential into a
product catalog, shared runtime directory, or another tenant's scope.

### Tenant and project enablement

The endpoint/preset definition is product-wide; do not copy it into each
tenant. A tenant that will use the integration still needs its own authorized
connection when credentials belong to the organization. In the explicit
service-binding model, declare the connection as organization-owned
(`owner_kind: "organization"`, `tenant_slug`, and a matching `owner_ref`),
limit `allowed_actions`, and set per-action `approval_policy` in accordance
with [`service-binding-record.schema.json`](../schemas/service-binding-record.schema.json).
Projects reference the applicable binding IDs through the governed project
facade. A personal connection must stay person-owned and must not be assigned
to an organization or tenant.

### Create and attach a tenant binding

Create an organization-owned binding through the governed controller after the
tenant profile and service catalog entry exist:

```bash
pnpm service:setup binding create \
  --tenant <tenant-slug> \
  --service <service-id> \
  --binding-id <stable-binding-id> \
  --target <account-or-workspace-label> \
  --actions <preset-operation-id,...> \
  --approval approval_required
pnpm service:setup binding list --tenant <tenant-slug>
```

The controller verifies that the tenant is active, the service preset exists,
and each action is declared by that preset. It writes an organization-owned
record with matching `tenant_slug`/`owner_ref`; it never accepts secret values.
For operations marked `tenant_binding_required` (directly or by the preset's
top-level setting), service-actuator enforces the binding's tenant, optional
project attachment, allowed action, and `approval_policy` before execution.
The active mission must carry the same `tenant_slug`, or reference the scoped
project that does; a caller-supplied tenant slug by itself is not authority.
Tenant-bound work must use the declared `PRESET` operation path, not raw API,
CLI, SDK, or MCP modes.
An omitted action policy is denied. When a project has exactly one matching
binding it is selected automatically; if several match, the trusted service
context must set `service_binding_id` to one of the project's referenced
binding IDs. Use `--secrets
<secret-reference,...>` only for non-secret reference names. Attach the
resulting binding ID to a project through
`pnpm project bootstrap --service-bindings` (or the governed project update
flow). Do not edit
`active/shared/runtime/service-bindings/` directly.

The binding registry enforces action policy only for operations explicitly
marked `tenant_binding_required`; it does not change older service contracts.
Credential resolution still uses the service-level secret guard. `pnpm
kyberion secret introduce <service-id> <secret-key>` stores credentials for the
active service profile/customer stance; it does not put a value into a tenant
binding. It is suitable for a shared runtime credential, not for isolating
different organization tokens. For services whose provider accounts or tokens
differ by tenant, the current secret resolver needs a tenant-aware credential
backend before those connections can be treated as operational and
credential-isolated. Run `pnpm service:setup` and
`pnpm service:preflight -- --service <service-id>` for credential readiness.

Separately, if the tenant will send confidential or personal data to the
service, the destination domain must be approved in the tenant-specific egress
policy. Registering a service globally or selecting a `KYBERION_CUSTOMER`
stance does not grant that tenant data-egress permission. Some direct
older integrations that do not opt into `tenant_binding_required` continue
using their existing service-level credential and authority paths. Do not
treat those legacy paths as tenant-isolated connections. Do not invent a
second tenant copy of the endpoint catalog.

### Local service and bridge readiness

Some entries need more than a secret. `comfyui` uses service-runtime lifecycle
and endpoint reachability; `voice` and `meeting` can use bridge health;
`google-workspace` may combine CLI and service auth. Use readiness checks
reported by `service:setup` and `service:preflight`. A meeting preset does not
mean every meeting provider is implemented; check the preset and driver for
the supported operations.

## Retired registration shortcut

The former `new-service-integration` config mission wrote a record under the
old `knowledge/product/governance/service-presets/` path and a placeholder
credential JSON. It did not register the current endpoint/preset catalogs and
bypassed the current secret-introduction flow. It has been removed. Use this
guide for catalog work and `service:setup` / `secret introduce` for connection
setup.

## Related references

- [Service endpoint catalog contract](service-endpoints/README.md)
- [Secret Introduction Model](../architecture/secret-introduction-model.md)
- [Initialization: external service setup](../../../docs/INITIALIZATION.md#4b-external-service-setup-and-preflight)
- [Service capability inventory](../../../CAPABILITIES_GUIDE.md)

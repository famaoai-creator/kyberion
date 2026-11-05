---
title: Stance / Tenant / Customer — three layers that all get called "customer"
tags: [architecture, governance, tenant, customer, stance, affiliation, multi-tenant]
last_updated: 2026-11-05
---

# Stance / Tenant / Customer

Three different things in Kyberion are routinely called "customer". They sit at
different layers, and conflating them puts records on the wrong side of a
confidentiality boundary. This document names them.

| Layer                 | Question it answers                         | Where it lives                                           | Lifetime                          |
| --------------------- | ------------------------------------------- | -------------------------------------------------------- | --------------------------------- |
| **Stance**            | Which stance am I operating from right now? | `knowledge/personal/stances/{slug}/` + `KYBERION_STANCE` | Runtime; switches per session     |
| **Tenant**            | Which confidentiality boundary am I inside? | `knowledge/confidential/{tenant}/`                       | Durable; a data boundary          |
| **Tenant's customer** | Who does that tenant deliver to?            | `knowledge/confidential/{tenant}/customers/`             | Durable; data owned by the tenant |

The canonical containment hierarchy is
`tenant_slug → organization_id → project_id → mission_id → task_id → session`
([entity-scope-hierarchy](./entity-scope-hierarchy.md)). Stance is not in it,
because a stance is configuration, not a scope.

## Stance is an overlay, not an entity

`knowledge/personal/stances/{slug}/` overlays `knowledge/personal/`: identity, connections, policy,
voice, mission seeds, onboarding and the tenant profiles the stance may act for
(`libs/core/stance-resolver.ts`). Setting `KYBERION_STANCE` changes _who Kyberion
thinks it is acting as_. A stance is the operator's own configuration (custody
`person`), so it lives in the personal space; its run traces go to
`active/shared/logs/stances/{slug}/traces/`.

Stances used to live in a top-level `customer/{slug}/` directory, named for
Forward Deployed Engineer engagements where the stance happens to be a
customer's, and selected by `KYBERION_CUSTOMER` (now the deprecated name of
`KYBERION_STANCE`). Because an engagement's stance slug and tenant slug are the
same value, that directory also collected the tenant's company assets and its
customers' records. Those are tenant data and move out separately
(S2: `knowledge/confidential/{tenant}/`, S3:
`knowledge/confidential/{tenant}/customers/{customer}/`); until then the legacy
`customer/{tenant}/` holds only them. See
[the store-catalog guard design](../../../docs/developer/improvement-plans-2026-11/STORE_CATALOG_GRANT_GUARD_DESIGN_2026-11-05.ja.md).

Two stances that matter in practice:

- **Engagement** — running Kyberion on behalf of an end customer.
- **Concurrent affiliation** — holding roles at several independent legal
  entities and acting as one at a time. The stance carries that entity's
  connections and approval policy, so "which hat" is explicit rather than
  implied by what you happen to type.

## Why a tenant's customers must stay inside the tenant

A tenant is defined by three properties together
([multi-tenant-operations](./multi-tenant-operations.md) §1): its own
confidential data, its own identity/authority/approval flow, and its own audit
and compliance posture.

When two tenants deliver to the same end customer, each holds its own contract,
data and obligations for that customer, under its own posture. Recording the end
customer once, globally, would merge them — and the merge is exactly the leak the
tenant boundary exists to prevent: staff scoped to tenant A would see tenant B's
terms with the shared customer.

So the same end customer legitimately appears under several tenants, and those
records are deliberately not deduplicated.

The cost is that no single place answers "what does the whole group deliver to
this end customer?". When that view is genuinely needed, it is built explicitly
as shared material for a tenant group (below) — a deliberate, audited act rather
than a side effect of storage layout.

## Crossing boundaries on purpose

Cross-tenant access is deny-unless-brokered and always audited
(`checkTenantGroupScope` / `brokeredTenants` / `brokerApproval` in
`libs/core/tier-guard.ts`). Two mechanisms, chosen by how often the crossing
happens:

- **Standing** — declare a group at
  `knowledge/confidential/tenant-groups/{group}.json` and put material cleared
  for all members under `knowledge/confidential/shared/{group}/`. Read without
  friction, because the clearance was decided once, explicitly.
- **Case by case** — a brokered access. Denied by default; each crossing leaves
  an audit record.

For someone holding concurrent roles at independent entities, this is not
bookkeeping. It makes accidental mixing the non-default, and leaves an
answerable record of every deliberate crossing: what moved, when, and under which
stance. That record is the only thing that can substantiate the claim afterwards.

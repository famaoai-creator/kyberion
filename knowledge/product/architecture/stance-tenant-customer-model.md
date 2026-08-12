---
title: Stance / Tenant / Customer — three layers that all get called "customer"
tags: [architecture, governance, tenant, customer, stance, affiliation, multi-tenant]
last_updated: 2026-08-12
---

# Stance / Tenant / Customer

Three different things in Kyberion are routinely called "customer". They sit at
different layers, and conflating them puts records on the wrong side of a
confidentiality boundary. This document names them.

| Layer                 | Question it answers                         | Where it lives                               | Lifetime                          |
| --------------------- | ------------------------------------------- | -------------------------------------------- | --------------------------------- |
| **Stance**            | Which stance am I operating from right now? | `customer/{slug}/` + `KYBERION_CUSTOMER`     | Runtime; switches per session     |
| **Tenant**            | Which confidentiality boundary am I inside? | `knowledge/confidential/{tenant}/`           | Durable; a data boundary          |
| **Tenant's customer** | Who does that tenant deliver to?            | `knowledge/confidential/{tenant}/customers/` | Durable; data owned by the tenant |

The canonical containment hierarchy is
`tenant_slug → organization_id → project_id → mission_id → task_id → session`
([entity-scope-hierarchy](./entity-scope-hierarchy.md)). Stance is not in it,
because a stance is configuration, not a scope.

## Stance is an overlay, not an entity

`customer/{slug}/` overlays `knowledge/personal/`: identity, connections, policy,
voice, mission seeds, and the tenant profile directory
(`libs/core/customer-resolver.ts`, `tenantProfileDir()`). Setting
`KYBERION_CUSTOMER` changes _who Kyberion thinks it is acting as_.

The directory is named `customer/` for historical reasons — it was introduced
for Forward Deployed Engineer engagements, where the stance happens to be a
customer's. That is one use, not the definition. Renaming it would touch
`KYBERION_CUSTOMER`, `customer-resolver`, `customer-channel-binding` and
`tier-guard`'s `${KYBERION_CUSTOMER}` substitution for little gain, so the name
stays and this document carries the meaning.

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

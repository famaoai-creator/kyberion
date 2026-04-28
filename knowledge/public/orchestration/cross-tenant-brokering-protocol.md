---
title: Cross-Tenant Brokering Protocol
category: Orchestration
tags: [multi-tenant, brokering, audit, isolation]
importance: 8
last_updated: 2026-04-27
---

# Cross-Tenant Brokering Protocol

## 1. Purpose

`tenant-scope-policy.json` declares `cross_tenant_rule: deny_unless_brokered`.
This document defines what "brokered" means and how a Kyberion mission
can legitimately mediate between two or more tenants without violating
isolation.

The default for any tenant-bound persona is **denied** — `tier-guard`
rejects writes / reads against another tenant's confidential prefix
(see [`multi-tenant-operations.md`](../architecture/multi-tenant-operations.md) §4).

A **brokered mission** is the only legal way for code to touch multiple
tenants in a single execution. Every brokered access is recorded in
`audit-chain` as a `tenant.broker_access` event.

## 2. When to use a brokered mission

Use a brokered mission when **all** of the following hold:

1. Both tenants have explicitly authorized the cross-tenant exchange
   (in writing, captured in mission evidence).
2. The mission's purpose is genuinely cross-tenant — e.g. settling a
   transaction whose effects must land on both ledgers, reconciling a
   shared resource, or producing a comparative report that one party
   alone cannot generate.
3. The output is redacted before either party sees the other's data,
   or the output explicitly carries metadata identifying which tenant
   contributed which row.

Do **not** use a brokered mission to:

- Bypass `tier-guard` for convenience (delegate to per-tenant missions
  instead).
- Aggregate data without contractual authorization.
- Avoid building per-tenant adapters when those would suffice.

## 3. Mission shape

A brokered mission must satisfy:

- `mission_state.tier` is `public` (broker missions live in the
  cross-tenant tier, not in any individual tenant's prefix).
- `mission_state.cross_tenant_brokerage.source_tenants` lists every
  tenant slug the mission may access. Slug regex:
  `^[a-z][a-z0-9-]{1,30}$`. Minimum 2 entries.
- `mission_state.cross_tenant_brokerage.purpose` is a human-readable
  description (≥ 20 chars) that lands in the audit event.
- Recommended: `approved_by` and `approved_at` capturing the
  authorization that justified opening the broker scope.

## 4. Runtime behavior

When a worker executes inside a brokered mission:

- `IdentityContext.brokeredTenants` is populated from
  `mission_state.cross_tenant_brokerage.source_tenants`.
- `IdentityContext.tenantSlug` may be undefined (the mission itself is
  not bound to one tenant) or set if the operator wanted to additionally
  restrict the broker session to a single tenant's prefix.
- `tier-guard.checkTenantScope` allows access to any path under
  `confidential/<slug>/` where `<slug>` is in `brokeredTenants`. Access
  to other tenants is denied as usual.
- Each allowed cross-tenant access emits a `tenant.broker_access`
  audit event carrying the target tenant and the broker list.

## 5. Authoring a brokered mission

```bash
# 1. Create the mission in public tier
node dist/scripts/mission_controller.js create \
  MSN-BROKERED-RECONCILE-2026-Q2 \
  --tier public \
  --persona ecosystem_architect

# 2. Hand-edit mission-state.json to declare the brokerage
#    (a CLI flag for this is on the roadmap; hand-edit until then)
cat <<JSON > active/missions/public/MSN-BROKERED-RECONCILE-2026-Q2/cross-tenant.json
{
  "source_tenants": ["acme-corp", "beta-co"],
  "purpose": "Quarterly settlement reconciliation between Acme and Beta",
  "approved_by": "compliance@acme,compliance@beta",
  "approved_at": "2026-04-27T00:00:00Z"
}
JSON
```

(A `--broker-tenants slug-a,slug-b` flag for `mission_controller create`
is tracked as a follow-up — for now, paste the JSON into the
`cross_tenant_brokerage` field of `mission-state.json`.)

## 6. Audit and review

- Every `tenant.broker_access` event must be reviewable by the
  affected tenants' CISOs. Per-tenant `TenantFilteringAuditForwarder`
  in `audit-forwarder.ts` automatically routes the event to **both**
  source tenants' SIEMs (since the event carries `target_tenant`).
- The mission's distill output (Phase ⑤ Review) must summarize what
  was touched per tenant.
- Quarterly: count broker missions per tenant pair; spike → investigate.

## 7. Failure modes

| Failure | Detection | Response |
|---|---|---|
| Brokered mission attempts a tenant not on the list | `tier-guard.tenant.scope_violation` audit event | Reject; investigate why the access was attempted |
| `cross_tenant_brokerage.source_tenants` empty | `mission_controller create` validation rejects | Add at least 2 tenants or use a regular tenant-bound mission |
| Brokered mission lives in `confidential/` rather than `public/` | tier-guard treats the mission's own dir as tenant-bound | Move mission to public tier; reissue authorizations |
| Audit forwarder fails to deliver `tenant.broker_access` to one tenant's SIEM | Quarterly compliance check; local chain authoritative | Backfill from local hash chain |

## 8. Reference

- [`multi-tenant-operations.md`](../architecture/multi-tenant-operations.md)
- [`libs/core/tier-guard.ts`](../../../libs/core/tier-guard.ts) — `checkTenantScope`
- [`libs/core/audit-forwarder.ts`](../../../libs/core/audit-forwarder.ts) — `TenantFilteringAuditForwarder`
- [`scripts/refactor/mission-types.ts`](../../../scripts/refactor/mission-types.ts) — `MissionState.cross_tenant_brokerage`

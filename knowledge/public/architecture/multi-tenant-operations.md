---
title: Multi-Tenant Operations
category: Architecture
tags: [multi-tenant, isolation, tier, governance, audit, operations]
importance: 8
last_updated: 2026-04-27
---

# Multi-Tenant Operations

Operational patterns for running Kyberion across multiple organizations
("tenants") on the same code base, with logical isolation that the policy
engine and audit chain can both enforce and prove.

## 1. Scope of "Tenant"

A tenant is a unit of organizational separation that satisfies all of:

- Has its own confidential data that must not leak to other tenants
- Has its own identity / authority / approval flow
- Has its own audit and compliance posture

In Kyberion this maps cleanly to:

- A directory under `knowledge/confidential/{tenant-slug}/`
- A set of authorities and personas tagged with that slug
- A subset of missions whose `tier_scope` is bound to that slug

It does **not** map to a separate code repository — the same code base
serves all tenants, only the data and authority layers differ.

## 2. Isolation Layers

| Layer | What enforces it | What it stops |
|---|---|---|
| Filesystem tier | `secure-io` + `tier-guard` | Reads / writes outside the caller's allowed prefixes |
| Path scope | `path-scope-policy.json` | A persona reaching across `mission_state`, `knowledge_core`, etc. |
| Tenant scope (this doc) | `tenant-scope-policy.json` (see §4) | A tenant's persona reading/writing another tenant's confidential prefix |
| Tier hygiene | `tier-hygiene-policy.json` | Tenant identifiers leaking into public-tier files |
| Mission ownership | `mission_controller` | Workers mutating mission state outside their assigned role |
| Audit chain | `audit-chain` | Backdating, tampering, replay |

These compose: a malicious or buggy persona must beat **all** layers to
exfiltrate or corrupt cross-tenant data. Each layer is independently
auditable from the chain.

## 3. Directory Conventions

```
knowledge/
  public/                       # cross-tenant reusable assets
  confidential/
    {tenant-slug}/              # tenant-private knowledge
      endpoints.json            # tenant-specific URLs / IDs
      variants/                 # tenant-specific overrides
      missions/                 # archived mission knowledge for this tenant
  personal/                     # per-user (not per-tenant)

active/
  missions/
    public/                     # cross-tenant tooling missions
    confidential/
      {tenant-slug}/            # tenant-scoped runtime missions
        MSN-{...}/
          mission-state.json    # has `tenant_slug` populated
          evidence/
          .git/                 # mission's independent repo
    personal/                   # per-user
  shared/
    coordination/
      tenant-queues/{slug}.jsonl  # per-tenant dispatch queue
```

The tenant slug is **lowercase, hyphenated, ASCII**, e.g. `acme-corp`,
matching `^[a-z][a-z0-9-]{1,30}$`.

## 4. Tenant Scope Policy

Add a top-level `tenant_scope_policy` block to mission control. The policy
declares per-tenant:

```json
{
  "tenants": {
    "acme-corp": {
      "display_name": "Acme Corp.",
      "confidential_prefixes": [
        "knowledge/confidential/acme-corp/",
        "active/missions/confidential/acme-corp/"
      ],
      "personas": ["acme-operator", "acme-mission-controller"],
      "default_audit_forwarder": "acme-siem",
      "default_secret_resolver": "acme-vault"
    }
  },
  "cross_tenant_rule": "deny_unless_brokered"
}
```

`cross_tenant_rule = deny_unless_brokered` means:

- Personas tagged with one tenant cannot read / write paths under another
  tenant's `confidential_prefixes`.
- The only legal cross-tenant communication is via a *brokered mission* —
  a `public`-tier mission whose explicit purpose is to mediate between two
  tenants, with all artifacts redacted to the broker's tier.

Implementation hint: extend `tier-guard.ts` to consult the active persona's
`tenant_slug` (read from `KYBERION_TENANT` env or mission state) and reject
writes to a different tenant's confidential prefix.

## 5. Mission Lifecycle in Multi-Tenant Mode

`mission_controller create <ID>` should accept `--tenant <slug>` (or read
`KYBERION_TENANT` env). The created mission lands at
`active/missions/confidential/{slug}/{ID}/` and its `mission-state.json`
records `tenant_slug`.

Workflow:

1. **Intake** — operator declares the tenant via env or flag.
2. **Classification** — mission class is determined as usual.
3. **Team composition** — only personas tagged for that tenant (or
   tenant-agnostic personas like `nerve-agent`) are eligible.
4. **Execution** — `secure-io` rejects writes to other tenants' prefixes.
5. **Audit** — events flow into the audit-chain with a `tenant_slug`
   field, and the audit forwarder routes per-tenant to that tenant's SIEM.
6. **Distillation** — distilled knowledge lands in
   `knowledge/confidential/{slug}/missions/` unless tenant explicitly
   approves promotion to public.

## 5b. First-Tenant Onboarding Runbook (8-Week Reference)

The 2026-04-27 outcome simulation (MSN-OUTCOME-SIM-20260427, scenario A)
produced this runbook for moving from a single-tenant deployment to the
first paying-customer multi-tenant deployment in 8 weeks. The
prerequisite milestones are non-negotiable; the optional items are
explicit deferrals with their compensating controls.

### Week 1 — declarative isolation foundation

- [ ] Author `tenant-scope-policy.json` listing every tenant, its
      `confidential_prefixes`, eligible personas, and per-tenant adapter
      defaults.
- [ ] CI validation: `pnpm run check:contract-schemas` covers
      `tenant-scope-policy.json`. PRs that add a tenant must update
      both the policy file and the schema.
- [ ] Tenant slug regex (`^[a-z][a-z0-9-]{1,30}$`) added to a hygiene
      check: any directory under `confidential/` whose first segment
      does not match is flagged.
- [ ] Per-tenant deployment unit decided (1 runtime process per tenant
      vs shared with stricter scoping). Document the choice.

### Week 2 — `tier-guard` tenant enforcement

- [ ] `IdentityContext.tenantSlug` populated from `KYBERION_TENANT` env
      and from `mission-state.json` (`tenant_slug` field).
- [ ] `validateWritePermission` and `validateReadPermission` reject
      cross-tenant `confidential/{other-slug}/` access; SUDO bypasses.
- [ ] `tenant.scope_violation` audit event fires on each rejection.
- [ ] Test suite: `tier-guard-tenant.test.ts` covers same-tenant allow,
      cross-tenant deny, SUDO bypass, legacy non-slug paths,
      malformed-slug rejection.

### Week 3 — audit-chain `tenant_slug` first-class

- [ ] `AuditEntry.tenantSlug?` added; `record()` auto-fills from the
      identity context.
- [ ] `TenantFilteringAuditForwarder` available; document
      `ChainAuditForwarder([TenantFilter(tenant=A, sink=siemA), …])`
      pattern.
- [ ] Per-tenant SIEM endpoints configured via
      `KYBERION_AUDIT_FORWARDER_*` env variables with one runtime
      process per tenant.
- [ ] Watchdog: `pnpm watch:tenant-drift` cron'd every 15 minutes;
      first finding paged to operator chat.

### Week 4 — staging dry-run for the first tenant

- [ ] Per-tenant `SecretResolver` chain wired (Vault / KMS / Secrets
      Manager namespaced by tenant).
- [ ] Per-tenant `DeploymentAdapter` if customer's CI is segregated.
- [ ] `mission_controller create --tenant <slug>` records `tenant_slug`
      in mission-state and lands the mission under
      `active/missions/confidential/{slug}/`.
- [ ] Run the customer's first end-to-end mission in staging; verify no
      `tenant.scope_violation` and that all audit events are filtered
      to the customer's SIEM.

### Week 5 — operational tabletop

- [ ] Tabletop exercise: each `Operational Failure Mode` from §9 below.
      Confirm detection, response, and recovery.
- [ ] Penetration test focused on cross-tenant access from a
      tenant-bound persona (confirm both `tier-guard` and the watchdog
      catch the path).
- [ ] DR drill: lose the per-tenant audit forwarder; confirm local
      chain stays authoritative and backfills on recovery.

### Week 6 — production cutover

- [ ] Customer kickoff mission (with `tenant_slug`) executed end-to-end
      in production.
- [ ] Real audit events visible in customer's SIEM, none in others.
- [ ] All policies (tenant-scope, tier-hygiene, contract-schemas) green
      in CI.

### Week 7 — observability and review

- [ ] First weekly compliance report from §8 below produced and
      delivered to customer's CISO.
- [ ] `mission_controller list` filtered by tenant works for the
      customer's operator.
- [ ] Operator surface: pick MOS or structured-CLI path per
      `operator-surface-strategy.md` §9.2 decision tree.

### Week 8 — handover and documentation

- [ ] Customer-side runbook published (specific to their tenant slug).
- [ ] On-call rotation includes the customer's per-tenant alert
      channels.
- [ ] Mission `MSN-FIRST-TENANT-LAUNCH` distilled; lessons land in
      `knowledge/incidents/`.

### Items explicitly deferred to Phase 2 (post-launch)

- `brokered_mission` flow for cross-tenant communication (initial
  posture: cross-tenant communication is **denied**, not brokered).
- Per-tenant rate limiting (one tenant can't yet exhaust shared
  reasoning-backend quota — accept the risk on day 1, re-evaluate when
  the second tenant joins).
- Cross-tenant knowledge promotion automation (manual via
  `memory-promote` is acceptable initially).
- Voice-engine per-tenant configuration (single shared engine pool is
  fine while only one tenant is live).

## 5c. Dog-food meta-pattern: the rollout itself as a mission

The same 2026-04-27 outcome simulation surfaced this pattern as
philosophically interesting:

> Run the multi-tenant rollout itself as a Kyberion mission, in the
> tenant's own confidential tier. The mission's audit-chain becomes a
> live demonstration of the governance Kyberion is selling.

This is appealing but **does not** substitute for the prerequisite work
in §5b. The mission framework can document the rollout, but it cannot
fill in missing `tier-guard` enforcement. Treat this pattern as a
delivery quality boost, not a shortcut around any of the milestones
above.

## 6. Per-Tenant Adapters

Each tenant typically configures its own:

| Adapter | Mechanism |
|---|---|
| Reasoning backend | `KYBERION_REASONING_BACKEND` per worker, plus tenant-specific model preferences in tenant config |
| Audit forwarder | `KYBERION_AUDIT_FORWARDER_*` set per tenant runtime |
| Secret resolver | `SecretResolver` chain with tenant-specific provider |
| Deployment adapter | `KYBERION_DEPLOY_COMMAND` per tenant CI |
| STT / voice | `voice-engines/*.json` canonical engine manifests, with `voice-engine-registry.json` as compatibility snapshot |

A practical pattern is one runtime process per tenant, each with its own
env, sharing the same code base. This keeps the runtime layer simple and
the tenant boundary explicit.

## 7. Cross-Tenant Knowledge Sharing

Public-tier knowledge is shared across all tenants by default. To export a
nugget of tenant knowledge to public:

1. Promote via `mission_controller memory-promote` from the source tenant.
2. The candidate is reviewed by the source tenant's `knowledge_steward`.
3. On approval, redact identifiers (the `tier-hygiene` lint MUST pass).
4. The promoted version lives under `knowledge/public/`; the original
   stays under `knowledge/confidential/{slug}/`.

Reverse direction (public → tenant) is implicit — tenants always consume
public tier.

## 8. Audit and Compliance

The audit-chain emits one entry per event with these tenant-aware fields:

- `tenant_slug` (string, optional — empty for cross-tenant tooling)
- `mission_id`
- `actor.persona`, `actor.authority_role`
- `path_touched` (when applicable)
- `parent_hash`, `hash`

Per-tenant export to SIEM is achieved by routing through a
`ChainAuditForwarder` whose first stage filters by `tenant_slug` and whose
HTTP / shell sinks are tenant-specific.

Compliance checks (e.g. weekly):

- All confidential events for tenant X are present in tenant X's SIEM
- No event for tenant X appears in tenant Y's forwarder
- `tier-hygiene` passes on all public-tier files
- `check:contract-schemas` passes

## 9. Operational Failure Modes

| Failure | Detection | Response |
|---|---|---|
| Persona writes to wrong tenant prefix | `tier-guard` rejects write | Audit event `tenant.scope_violation`; persona is automatically downgraded; on-call paged |
| Cross-tenant promotion missing redaction | `tier-hygiene` lint fails in CI | Block release; require redaction |
| Tenant SIEM unavailable | audit-forwarder logs warning, local chain continues | Backfill on recovery from local chain |
| Tenant secret unavailable | `SecretResolver` returns null | Mission halts with explicit error; no degraded fallback |

## 10. Migration Pattern (single-tenant → multi-tenant)

When introducing the second tenant:

1. Pick a slug for the existing implicit tenant (e.g. `default`).
2. Move `knowledge/confidential/*` under `knowledge/confidential/default/`.
3. Move active missions under `active/missions/confidential/default/`.
4. Add `tenant-scope-policy.json` with `default` and the new tenant.
5. Tag every existing persona with `tenant_slug: default`.
6. Add the new tenant's personas, prefixes, adapters.
7. Run `pnpm run validate` — `check:tier-hygiene` and
   `check:contract-schemas` must remain green.

## 11. Known Limits

- The current `tier-guard` does not yet enforce tenant scoping (only path
  scope). Implementing §4 needs an extension to read `tenant_slug` from
  identity context.
- `audit-chain` does not yet carry `tenant_slug` as a first-class field;
  add via the next chain version with a migration path.
- Per-tenant rate limiting (e.g. one tenant exhausting reasoning quota)
  is not implemented; treat as future work.

## 12. Reference

- [`tier-hygiene-policy.json`](knowledge/public/governance/tier-hygiene-policy.json)
- [`path-scope-policy.json`](knowledge/public/governance/path-scope-policy.json)
- [`tiered-consensus-and-experimental-branches.md`](knowledge/public/governance/tiered-consensus-and-experimental-branches.md)
- [`libs/core/secure-io.ts`](libs/core/secure-io.ts)
- [`libs/core/audit-chain.ts`](libs/core/audit-chain.ts)
- [`libs/core/audit-forwarder.ts`](libs/core/audit-forwarder.ts)
- [`libs/core/secret-resolver.ts`](libs/core/secret-resolver.ts)

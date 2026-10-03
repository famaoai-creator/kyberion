---
title: Scope Governance Plane
tags: [architecture, governance, scope-envelope, control-plane, approval, taint, workspace]
last_updated: 2026-10-03
roles: [mission_controller, ecosystem_architect]
phases: [execution, review]
---

# Scope Governance Plane

Three scope systems — the entity-scope hierarchy, workspace isolation, and
the cloudflare-os control plane — used to be parallel mechanisms that merely
happened to share `mission_id`. The scope governance plane projects them onto
one governed scope model: a runtime-minted **two-layer envelope** whose
identity every governed record derives from and whose policy only narrows.

## The two-layer envelope

`libs/core/scope-envelope.ts` — `ScopeEnvelope`:

- **Identity layer** — canonical `tenant_slug → organization_id →
project_id → mission_id → task_id` (`ENTITY_SCOPE_HIERARCHY`), minted at
  dispatch boundaries and never trusted from client input.
- **Policy layer** — attenuable policy (`security_scope`, `purpose`, read
  tiers). `policyNarrow` can only shrink: wider tiers, a different tenant or
  mission, or a minted-envelope contradiction all fail closed with
  `[POLICY_VIOLATION]`.

The envelope lives in AsyncLocalStorage; `currentScopeEnvelope()` is what
governance stages read first. Delegation narrows the parent envelope for
the child work item before claim — never widens.

## The one governed flow

```text
dispatch boundary (delegation, actuator, pipeline)
  └─ mintScopeEnvelope / narrowScopeEnvelope        SC-01
        └─ runOpPreflight waterfall                 SC-02/05/06
             core:scope        100  envelope exists + narrows cleanly
             core:effect       110  manifest effect -> governance stamp
             core:introduction 112  write/egress need resource intro
             core:taint        115  egress gets mission taint stamp
             core:provenance-egress 118  taint vs declared target
             core:adf-guardrails / provider-egress  120/130
        └─ execute (stamps stripped; they never reach the op schema)
        └─ post-op recordOpObservation              SC-05
        └─ approvals: approval-store is the ONE path  SC-04
             held_effect steering -> held-effect-bridge -> journal
```

Every op's effect class (`none|read|write|egress`) is declared in its
manifest capability (SC-02; `op-effect-coverage` gate enforces 100%).
Stage modes roll out per op family via
`knowledge/product/governance/op-preflight-rollout.json` — `warn` audits
before `enforce` blocks.

## Each mechanism's responsibility on the plane

| Mechanism        | Before                                                        | On the plane                                                                                                                                                |
| ---------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| entity-scope     | context fields copied per record                              | envelope identity; `resolveOwnerScope` derives tier/tenant from the mission dir                                                                             |
| workspace ledger | `WorkspaceOwner` parallel type                                | `Pick<ScopeContext>` subset; orphan/visibility via `tryResolveOwnerScope`; `KYBERION_TENANT`-bound lists filter (SC-07)                                     |
| control plane    | flat `control-plane.json`, per-module instances, lost updates | tenant-namespaced append-only journal per `runtime/<tier>/<tenant>/cloudflare-os/`; `getControlPlaneForScope` is the only construction site (SC-03/08)      |
| held actions     | parallel approval queue + restart-broken executors            | serializable params + `registerExecutor`; decisions are `held_effect` steering in the shared approval store, settled by the bridge into the journal (SC-04) |
| taint/egress     | `assertEgressAllowed` few callers, no declassify              | `evaluateProvenanceEgress` single rule; egress guard on every `effect:egress` op; `requestDeclassify` hash-bound artifact grants (SC-06)                    |

## Invariants (fail-closed in CI)

`libs/core/scope-governance-invariants.test.ts` + `check_op_effect_coverage`:

1. `mintScopeEnvelope` runs only at dispatch boundaries.
2. `tenantSlug` lives only on declared scope-identity record fields.
3. Preflight stage order is fixed (100 → 130).
4. `new CloudflareOsControlPlane(` exists only in `cloudflare-os-shared.ts`.
5. Every manifest capability declares `effect`.
6. Approval decisions — mission verbs and held effects alike — travel the
   shared `decideApprovalRequest` choke point.

## Links

- [entity-scope-hierarchy](./entity-scope-hierarchy.md) — the identity chain
- [multi-tenant-operations](./multi-tenant-operations.md) — tenant scope rules
- [runtime-storage-layout](./runtime-storage-layout.md) — journal floors
- Plan: `docs/developer/improvement-plans-2026-10/SCOPE_GOVERNANCE_UNIFICATION_PLAN_2026-10-03.ja.md`
- Mission: `MSN-SCOPE-GOV-UNIFY-20261003` (PR #896)

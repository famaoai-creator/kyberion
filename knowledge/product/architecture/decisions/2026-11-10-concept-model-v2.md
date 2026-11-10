---
title: 'Concept Model v2: WorkItem as Issue, one Lease, Tenant 1:N Organization, Stance as acting-for, Grant = principal × scope × operation, one intent resolver, a closed memory loop'
category: Architecture
tags:
  [
    adr,
    concepts,
    workitem,
    lease,
    tenant,
    organization,
    stance,
    role,
    grant,
    intent,
    memory,
    decision,
  ]
importance: 10
author: Ecosystem Architect
last_updated: 2026-11-10
concepts:
  [
    work-item,
    lease,
    tenant,
    organization,
    stance,
    execution-persona,
    org-role,
    team-role,
    member-role,
    authority-role,
    grant,
    execution-shape,
    work-shape,
    routing-decision,
    memory-candidate,
  ]
---

# Concept Model v2

## Status

Accepted (2026-11-10, owner interview in MSN-CONCEPT-MODEL-V2-20261110). Code migrates under
the four plans listed at the end. Until a plan completes, the registry marks the affected terms
`lifecycle.state: transitioning` (or `deprecated`), so a reader can tell a decided meaning from
the code that still implements the old one.

## Context

The concept registry (MSN-CONCEPT-REGISTRY-20261109) made one definition per term checkable,
but several definitions were themselves the problem: they described accumulated
implementations, not a model. A read-only survey of `libs/core` found:

- **WorkItem** carries two roles in one record: an Issue-like tracker (`status`
  backlog→done, `priority`, `source` github/jira, boards, `dependencies`) and a concurrency lock
  (`lease_id`, `claimed_by_*`, `attempts`, `effect_ownership`). It is created at mixed
  granularity: one per mission (`deriveMissionOwnershipItemId`), one per mission task, one per
  dot action, one per discussion next step, with no parent link. Issue-sized and step-sized
  items share a board.
- **Lease** is implemented separately by mission control (`libs/core/mission/mission-lease.ts`
  on `libs/core/lease/lease-backend.ts`), WorkItems, Co-Session path leases, dot arbitration,
  video and audio device leases.
- **Tenant / Organization** disagree on cardinality. The scope chain says
  `tenant → organization` (1:N), each tenant home holds one `organization-profile` and one
  Company, and NHI ids are keyed `kyberion://agent/<org>/<slug>` with an optional tenant and an
  `org = 'default'` fallback.
- **Stance** was described as an identity (registry), runtime configuration (GLOSSARY) and a
  "customer overlay" (legacy `KYBERION_CUSTOMER`). It started as "which customer's position an
  FDE is in now" and absorbed customer-communication concerns.
- **Role** has six unrelated kinds: Execution Persona, Authority Role, Org Role, Team Role, the
  human member role (`owner|approver|operator|viewer`, declared six times), and the viewer role
  (`readonly|localadmin`). `mission-state.assigned_persona` holds an Org Role
  (`product_manager`) and is normalised into an Execution Persona, so it mostly becomes
  `worker` or `unknown`. Execution Persona began as a prompt technique ("you are a renowned …")
  and accreted authority, then Web-RBAC ideas.
- **Authority** has two disagreeing registries: `authority-role-index.json` (55 roles) and
  `security-policy.json` `authority_role_permissions` (86 roles). The tier-guard redesign
  already counts 95 authority roles, 40 of them store-specific
  ([STORE_CATALOG_GRANT_GUARD_DESIGN](../../../../docs/developer/improvement-plans-2026-11/STORE_CATALOG_GRANT_GUARD_DESIGN_2026-11-05.ja.md)).
- **Intent routing** has about 13 routers/classifiers. Nine call the core resolver
  (`libs/core/intent/intent-resolution.ts`) independently, often more than once per request. Their
  output vocabularies disagree: `ExecutionShape` 7 values, `routeFamily` 5,
  `IntentResolutionShape` 4 (which folds `pipeline` into `task_session`), the dot `work_shape` 4,
  and the organization `work_shape` 6. The two `work_shape` fields mean different things.
  "Promote to mission" is decided in four places.
- **Memory loop** has nine capture stores, three candidate formats (`MemoryCandidate`,
  `DistillCandidateRecord`, `OrganizationLearningCandidate`) and four queues. "distill",
  "wisdom", "hint", "memory" and "promotion" each have several meanings. Promoted records under
  `knowledge/product/evolution/*/generated/` are not retrieved by relevance into tenantless
  mission context packs (`libs/core/knowledge/distill-knowledge-injector.ts` matches top-level
  `distill_*.md` only), so the loop is open.

## Decision

### D1 — WorkItem is the Issue; steps are child WorkItems; leases are taken on children

A top-level WorkItem is the trackable unit of work (an Issue): what should happen, for whom,
in which scope, and in what state. Mission, Task Session, Pipeline and a dot run are **ways of
executing** a WorkItem, not competing units. A mission task, a dot action or a discussion
next step that needs ownership becomes a **child WorkItem** with an explicit `parent_item_id`.
Claims and leases are taken on the child at the granularity that needs exclusion; the parent
aggregates status. Boards show top-level WorkItems by default. `work_shape` (solution_project,
service_operation, …) is a property of the top-level WorkItem: what kind of work this is.

### D2 — One Lease primitive

`libs/core/lease/` (`LeaseBackend`, fenced records) is the single lease primitive: acquire,
renew, release, expire, fence token, holder, and audit. It is resource-agnostic. WorkItem
claims, Mission Lease, Co-Session path leases, dot arbitration and device leases become thin
adapters that name a resource and delegate to it. No module keeps its own expiry or holder
bookkeeping.

### D3 — Tenant 1:N Organization

A tenant is the contract and isolation boundary. Organizations are the operating units inside
it (departments, business units). Company is an alias for tenant, not a third level. An NHI
belongs to a tenant and optionally to an organization inside it. The NHI id carries the tenant
(`kyberion://agent/<tenant>/<org|_>/<slug>`), `tenant_slug` is required, and the
`org = 'default'` fallback is removed. Organization profiles are stored per organization.

### D4 — Stance is the acting-for selection

A Stance is the state an operator (human or agent, typically an FDE serving several customers)
selects to say **which tenant they are acting for now, as which Organization and Org Role**.
It is chosen from the tenants the operator is permitted to serve, and switching it switches
the data scope accordingly. Customer communication (tone, contact window, route) is not part
of a stance. It belongs to Tenant's Customers and Channel. The name "customer overlay" and
`KYBERION_CUSTOMER` are retired.

### D5 — Role axes, one type each; Execution Persona is removed

| Axis                       | Term                        | Values / source                                              |
| -------------------------- | --------------------------- | ------------------------------------------------------------ |
| Who                        | NHI, Member                 | `agent-identity.ts`; member registry                         |
| Membership standing        | Member Role                 | `owner`, `approver`, `operator`, `viewer`. One exported type |
| What may be done           | Authority Role → Grant (D6) | one registry                                                 |
| Place in the org chart     | Org Role                    | `knowledge/product/roles/`. Field `org_role`                 |
| Role in this piece of work | Team Role                   | mission team templates                                       |

Execution Persona is removed as a concept. Its prompt-framing purpose ("you are a renowned …")
moves to the Team Role's prompt addendum. Its authority purpose moves to Grant. The viewer
role (`readonly|localadmin`) is folded into Member Role. `mission-state.assigned_persona` is
renamed `org_role` and is never normalised into an authority class.

### D6 — Grant = principal × scope × operation

Permission has one shape: a **principal** (Member or NHI) may perform an **operation set** within
a **scope** (custody / tier / tenant → organization → project …), for a lifetime. An Authority
Role is only a named bundle of operations. Which information a principal may touch is decided
by the scope (the information-asset scope model: custody, disclosure, processing), never by the
role's name. Org Role and Team Role carry no permissions of their own. They map to default
Grants. There is one role/operation registry. Standing grants, task-scoped grants and the
store grants (許可証) of the tier-guard redesign are instances of this shape. This extends
[STORE_CATALOG_GRANT_GUARD_DESIGN](../../../../docs/developer/improvement-plans-2026-11/STORE_CATALOG_GRANT_GUARD_DESIGN_2026-11-05.ja.md)
and
[INFORMATION_ASSET_SCOPE_MODEL_DESIGN](../../../../docs/developer/improvement-plans-2026-11/INFORMATION_ASSET_SCOPE_MODEL_DESIGN_2026-11-05.ja.md),
not a parallel design.

### D7 — One intent resolver, thin surface adapters

Only one function reads utterance text: the intent resolver. It emits a single
**RoutingDecision** once per request: intent id, `ExecutionShape`, authority level, delivery mode
and promotion verdict. Slack, voice, terminal, front desk, discussion room and dot are
adapters that pass text (or structured next steps) in and consume the decision. The promotion
verdict ("does this become a mission?") is decided only by `work-scope-policy.json`.
`ExecutionShape` is the only execution vocabulary. The dot `work_shape` becomes
`execution_shape`, and `IntentResolutionShape` / `routeFamily` become projections of it.

### D8 — A closed, scoped memory loop

1. **Close the loop first.** Promoted knowledge reaches later work by relevance through the
   knowledge index, filtered by the reader's Grant scope. The `distill_*` side corpus and its
   injector are retired. A loop-health metric (promoted → retrieved → used) is reported and
   gated.
2. **One candidate type, one queue.** Every learning (mission distill, organization learning,
   process improvement, execution feedback, heuristics, trace hints) is a candidate of one type
   with `kind` and `lane`. It carries **tier and entity scope from the moment of capture**, so
   disclosure is never inferred later.
3. **One meaning per word.** _distill_ = mission → candidate; _promote_ = candidate →
   knowledge; _wisdom_ = the actuator name only; _hint_ = one runtime hint store plus a generated
   `HINTS.md` view.

## Consequences

- The registry gains `lifecycle` (transitioning / deprecated, with decision and plan), checked
  by the `concept-registry` gate. Terms whose code lags carry it until their plan completes.
- Execution Persona is `deprecated` (replaced by Authority Role / Grant and Team Role). The
  legacy alias "customer overlay" is removed from Stance.
- Order of migration, by dependency. Memory disclosure and routing authority both sit on
  scope and Grant.
  1. [Scope, identity and Grant](../../../../docs/developer/improvement-plans-2026-11/SCOPE_IDENTITY_GRANT_CONSOLIDATION_PLAN_2026-11-10.ja.md) (D3–D6)
  2. [WorkItem and Lease](../../../../docs/developer/improvement-plans-2026-11/WORKITEM_ISSUE_LEASE_CONSOLIDATION_PLAN_2026-11-10.ja.md) (D1–D2)
  3. [Intent resolver](../../../../docs/developer/improvement-plans-2026-11/INTENT_RESOLVER_UNIFICATION_PLAN_2026-11-10.ja.md) (D7)
  4. [Memory loop](../../../../docs/developer/improvement-plans-2026-11/MEMORY_LOOP_CLOSURE_PLAN_2026-11-10.ja.md) (D8)
- Each plan ends by dropping its terms' `lifecycle` from the registry, which is the observable
  "done" signal for the concept.

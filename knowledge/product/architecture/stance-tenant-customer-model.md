---
title: Stance / Tenant / Customer — three layers that all get called "customer"
tags:
  [
    architecture,
    governance,
    tenant,
    customer,
    stance,
    affiliation,
    multi-tenant,
    channel,
    credential-custody,
  ]
last_updated: 2026-11-16
concepts: [stance, tenant, tenants-customers, credential-custody]
---

# Stance / Tenant / Customer

Three different things in Kyberion are routinely called "customer". They sit at
different layers, and conflating them puts records on the wrong side of a
confidentiality boundary. This document names them
([Concept Model v2 D4](./decisions/2026-11-10-concept-model-v2.md)).

| Layer                 | Question it answers                                                    | Where it lives                                                                                                                  | Lifetime                          |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **Stance**            | Which permitted tenant am I acting for now, as which Org and Org Role? | `knowledge/personal/stances/{slug}/stance.json` (`acting_for`) + `KYBERION_STANCE`                                              | Runtime; switches per session     |
| **Tenant**            | Which confidentiality boundary am I inside?                            | `knowledge/confidential/{tenant}/`                                                                                              | Durable; a data boundary          |
| **Tenant's customer** | Who does that tenant deliver to, and how do we talk to them?           | `knowledge/confidential/{tenant}/customers/` (actors), `.../deals/` (deals), `.../connections/channel-bindings.json` (channels) | Durable; data owned by the tenant |

The canonical containment hierarchy is
`tenant_slug → organization_id → project_id → mission_id → task_id → session`
([entity-scope-hierarchy](./entity-scope-hierarchy.md)). Stance is not in it:
a stance is a _selection_ of a point in that chain, not a level of it.

## Stance is the acting-for selection

An operator — a human, or an agent such as an FDE serving several customers —
may be permitted to act for several tenants. A stance says which one they are
acting for right now, and as which Organization and Org Role:

```json
{
  "slug": "acme-engagement",
  "kind": "engagement",
  "acting_for": {
    "tenant_slug": "acme",
    "organization_id": "delivery",
    "org_role": "solution_architect"
  }
}
```

Rules (`libs/core/authn/stance-resolver.ts`):

- **Chosen from the permitted tenants.** `resolveStance` checks the selection
  against the operator's permitted tenants and rejects anything else
  (`[STANCE_NOT_PERMITTED]`). The permitted list is server-side authority: for
  the CLI it is the active profiles in the tenant registry
  (`knowledge/personal/tenants/`); for an HTTP surface it is the viewer
  credential's `tenant_slugs`. A stance never declares its own permission.
- **Switching it switches the data scope.** `pnpm stance:switch <slug>` writes
  an activation profile at `active/shared/runtime/stance.env`. Sourcing it
  selects the stance and replaces shell tenant and organization bindings.
  A selected organization must be registered under the selected tenant.
  The profile clears the previous tier, project, mission, task and NHI session
  and masks any previous NHI claim. Scope resolution skips persisted
  `scope.env` and checkout inference for this activation. A tenant-only stance
  leaves organization unset, and an overlay-only stance leaves tenant and
  organization unset. New work can supply explicit lineage and admit an NHI
  for its own scope. On a surface,
  `narrowViewerScopeToStance` narrows the `ViewerContext` to that tenant and
  organization, and `stanceResourceBinding` binds a `ResourceAccessScope`
  ceiling to it.
- **It only narrows.** A stance cannot widen what a credential grants: a tenant
  or organization outside the viewer scope is rejected, and a request ceiling
  bound to one tenant cannot be re-bound to another inside the same request.
  Cross-tenant work still goes through the brokered path below.

A stance directory also holds the operator's own configuration for that
engagement — identity, service connections, approval policy, voice, mission
seeds and onboarding state — which overlays `knowledge/personal/`
(`knowledge/personal/stances/{slug}/{path}` → `knowledge/personal/{path}`). It
is the operator's configuration (custody `person`), so it lives in the personal
space; its run traces go to `active/shared/logs/stances/{slug}/traces/`. A
stance without `acting_for` keeps only this overlay and binds no tenant.

## Concierge display selection and execution authority

The Concierge rail selects the work being viewed with a server-validated
`?tenant=` hint. It does not write a CLI stance, issue a grant, allocate a
connection, or change the executing agent. Personal-only users see their
personal context without creating a tenant; the personal aggregate remains
labelled as a summary when the server reports `aggregate: true`.

The rail describes this distinction beside the current context. Settings
groups connections by their existing owner and explains that an organization's
use of a personal connection requires owner-approved, purpose- and time-bounded
allocation. A listed connection or configured metadata is not execution
authorization or evidence that its transport is ready.

The rail pins its selection request to the current URL hint, ignores responses
from an older selection or an unmounted rail, and revalidates Back/Forward
navigation. Selecting the current context is a no-op. The destination still
validates the viewer on each request, and service execution independently checks
its actor, selected binding, delegation, and required approval.

No local account introduction or credential broker flow is added by this UI.
The display selector is not a server-side acting-for execution API.

## Customer communication belongs to the tenant

How a tenant talks to its customers — tone (language, conversation mode),
contact window and route — is tenant data, not part of any stance:

- **Channel** — `knowledge/confidential/{tenant}/connections/channel-bindings.json`
  binds a surface channel to the tenant with its `counterpart`, `language`,
  `mode` (`sales` / `support` / `requirements_hearing`) and disclosure level.
- **Tenant's Customers** — `knowledge/confidential/{tenant}/customers/{customer}/`
  holds the customer's decision actors, each with the bound `channel` reminders
  go to.

Two operators acting for the same tenant therefore reach the customer the same
way, whatever their own stance holds.

## History: the retired "customer overlay"

Stances used to live in a top-level `customer/{slug}/` directory, named for FDE
engagements, and were selected by `KYBERION_CUSTOMER`. Because an engagement's
stance slug and tenant slug were the same value, that directory also collected
the tenant's company assets and its customers' records. Those are tenant data
and moved out: company assets to the tenant home
`knowledge/confidential/{tenant}/` (`libs/core/organization/tenant-home.ts`),
the audit mirror to `active/shared/runtime/audit-mirror/confidential/{tenant}/`,
deals to `knowledge/confidential/{tenant}/deals/`, and channel bindings to
`knowledge/confidential/{tenant}/connections/`. `pnpm migration` (0001–0003)
empties an existing `customer/` directory.

The name "customer overlay" and `KYBERION_CUSTOMER` are retired. For one
release `KYBERION_CUSTOMER` is still read as a migration aid: when
`KYBERION_STANCE` is unset and `knowledge/personal/stances/<slug>/` exists, it
maps to that stance (the only deterministic mapping); any other value is
ignored. Both cases log one diagnostic warning (`libs/core/authn/stance-env.ts`).

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

## Credential custody: whose reasoning credential does tenant work use?

The tenant answers "whose data is this?". A reasoning credential has its own
owner — its **custody** — and the two are deliberately separate
([design](../../../docs/developer/improvement-plans-2026-11/CLAUDE_CLI_TENANT_CREDENTIAL_DESIGN_2026-11-16.ja.md),
`libs/core/secret/credential-custody.ts`). Custody reuses the custody-owner
vocabulary of provider attestations (`libs/core/contracts/custody-owner.ts`):
a credential is held by a **person** or a **tenant**; `system` custody never
lends. Person custody means the installation person who owns
`knowledge/personal/` (the owner member); a `person:<other>:…` ref is refused
(`[CREDENTIAL_CUSTODY_PERSON_MISMATCH]`).

**Registration.** `pnpm kyberion reasoning credentials register` stores the
value in the owner's store — `knowledge/personal/connections/<service>[.<label>].json`
(person, through secret introduction) or
`knowledge/confidential/<owner>/connections/<service>[.<label>].json` (tenant,
by an owner member of that tenant; replacing a registered value needs an
owner approval) — plus a non-secret record `<service>[.<label>].record.json`.
The record is the **only** source of the lending terms:

| Record field        | Meaning                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `credential_ref`    | `<person\|tenant>:<owner>:<service>[:<label>]`, e.g. `tenant:parent:anthropic`                                            |
| `kind` / `terms`    | `api_key` (commercial) or `subscription_token` (`claude setup-token`; Pro/Max/Ultra consumer, Team/Enterprise commercial) |
| `plan`              | `api` / `team` / `enterprise` / `pro` / `max` / `ultra`                                                                   |
| `token_expires_at`  | subscription tokens only; reminded 30 days ahead                                                                          |
| `contract_tenant`   | tenant-held Team/Enterprise seat only: always the owner tenant itself                                                     |
| `value_fingerprint` | `sha256:` of the value — never the value                                                                                  |

**Lending.** The owner may lend a credential to the work of another tenant
(the borrower) through the existing `credential.use` standing grant, whose
`credential_lending` scope copies the record's terms and fingerprint and adds
`allowed_backends` and an optional `budget_monthly_usd`. Assign flags never
set terms; they are only checked against the record. The owner approves (the
installation person, or an owner member of the owner tenant); the borrower's
data consent stays its provider attestation for `claude`. A value or record
that changed after approval is refused (`[CREDENTIAL_VALUE_CHANGED]`,
`[CREDENTIAL_RECORD_MISMATCH]`) until re-approved. The kind decides how far a
credential may be lent, checked at approval **and** at every use:

| Kind / terms                                | May be lent to                                                                           | Refusal                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------- |
| `api_key` / commercial                      | any tenant with a valid provider attestation                                             | `[CREDENTIAL_ATTESTATION_REQUIRED]` |
| person-held `subscription_token` (any plan) | only tenants whose verified `personal_owner` is the holder — never via a contract tenant | `[CREDENTIAL_KIND_NOT_ELIGIBLE]`    |
| tenant-held `subscription_token` (seat)     | only its own owner tenant                                                                | `[CREDENTIAL_KIND_NOT_ELIGIBLE]`    |

`personal_owner` is an explicit tenant-profile fact set only by
`pnpm tenant personal-owner <slug> --person user:<member>` (approved by that
person, audited as `tenant.personal_owner_changed`), stored with its approval
basis and re-verified against the approval store at every use; a hand-edited
value counts for nothing. `pnpm kyberion doctor` warns with every personal tenant.
Company use of a seat or key is tenant custody, registered by that tenant's
owner (any change of value or terms needs the owner's approval). Member-registry `owner`
memberships and `assigned_role` are bootstrapped for every tenant and never
make a company tenant "personal".

A tenant-custody value read for another tenant's run is a brokered crossing
like any other: one exact-file capability bound to the owner, a durable
`credential.lent_read` audit row (credential_ref, borrower, mission/task,
grant), and the value goes only into the run's in-memory binding — never into
the borrower's storage. A subscription token is not a generic task secret:
only the isolated claude spawn reads it. Usage is metered per run on the
borrower's execution-metrics rows (`credential_ref`), in Asia/Tokyo business
months, summarized by the `credential-usage-monthly` Chronos job; 80% of the
budget notifies, 100% stops new runs and running bindings
(`[CREDENTIAL_BUDGET_EXCEEDED]`, per-use check on a one-minute cached total).
The isolated claude HOME (`active/shared/cache/<tier>/<borrower>/provider-auth/claude/<hash>/home`)
holds no credential (it is passed per launch) and may hold CLI session data;
it is cache: the cache floor's 30-day TTL removes it, and it is recreated at
the next bind.

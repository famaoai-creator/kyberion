---
title: Actor identity and responsibility model
tags: [architecture, governance, identity, nhi, tenant, organization, delegation, review]
last_updated: 2026-11-04
concepts: [nhi, conversational-persona, execution-persona, org-role, team-role]
---

# Actor identity and responsibility model

“Agent” can mean the person-facing assistant, a durable accountable identity, a
specialist, or a worker on one task. These are separate concepts. A name such as
Haru is the conversational window through which a human works; it is not a
credential, a tenant membership, or proof that two workers are independent.

## Separate the questions

| Concept                          | Question                                                             | Boundary                                                                   |
| -------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Conversational persona           | Who does the human talk to?                                          | Stable name, voice, and presentation; no authority by itself.              |
| Accountable human                | Who is responsible for the identity's activity?                      | Registered human referenced by the NHI ledger.                             |
| Durable non-human identity (NHI) | Which accountable actor performed this action?                       | Ledger identity, lifecycle, affiliation, and auditable runtime bindings.   |
| Tenant                           | Which company's confidentiality boundary contains this work?         | Isolation, access, and data handling.                                      |
| Organization participation       | Where does that actor belong and what responsibilities do they hold? | Durable assignments inside a tenant; not an access grant.                  |
| Expertise / capability profile   | What work is this worker equipped to do?                             | Selection and suitability; not permission or a durable identity.           |
| Task role                        | What is this worker doing on this task?                              | Owner, planner, implementer, reviewer, and other bounded responsibilities. |
| Delegated authority              | What may the worker do here and for how long?                        | Existing grants, scope envelopes, contracts, and approval gates.           |

The existing `Persona` / `KYBERION_BASE_ROLE` vocabulary in `libs/core/types.ts`
and `libs/core/authority.ts` is a **legacy execution identity class**, not the
conversational persona defined here. Likewise, the historical mission
`--persona` flag selects an Org Role. This model does not rename those runtime
APIs or change their authorization semantics.

## One conversational window, separate accountable identities

Haru can remain the familiar conversational window while acting through:

- a personal NHI for the human's personal work;
- a distinct NHI affiliated with company A's tenant for company A work;
- a distinct NHI affiliated with company B's tenant for company B work.

The personal identity is not a universal fallback for company work. Switching
the visible name, session, provider, or model does not switch authority. Tenant
work must resolve an explicitly tenant-affiliated identity and satisfy runtime
admission and the applicable authorization checks.

An organization is a responsibility structure within that tenant. An actor may
hold several organization responsibilities without becoming several people or
receiving wider access. Conversely, similar organization names or duties in two
companies do not merge their tenants. Reuse organization participant records and
the identity directory rather than creating a second personnel registry.

## Expertise, execution, and independent review

An engineering or design profile describes expertise. “Implementer” and
“reviewer” describe responsibility for a particular task. Selecting a profile
does not provision an NHI, grant access, or approve the result.

An independent review requires a genuinely separate reviewer with traceable
identity and review evidence. The implementer cannot become independent by
renaming itself, selecting another profile, opening another session, or changing
an actor alias. A distinct string alone is not evidence of independence. Use the
existing task-review and evidence mechanisms; assess the actual actor and its
relationship to the implementation. Human approval remains a separate decision.

This conceptual requirement is stronger than some legacy actor-string checks.
The changes described below do **not** claim to repair every alias-based review
path or prove independence automatically across all runtimes.

## Delegation does not transfer approval

Delegation provides a bounded objective, scope, outputs, and authority derived
from the delegator's existing permissions. It must not enlarge them. Assigning
an organization responsibility, task role, expertise profile, or conversational
persona is not an approval and does not bypass a charter or grant check.

Use the existing accountability charter, grant resolver, task-scoped grants,
and approval mechanisms. Required human decisions stay with the authorized
human. An automated reviewer can supply evidence without becoming that human.

## Information stays inside its boundary

The common conversational window does not imply a common memory or shared data
authority across tenants. Carry only the context authorized for the current
identity and task. Cross-tenant sharing remains deny-unless-brokered and
audited. Neither persona metadata nor a shared accountable human authorizes it.

There is no implicit downgrade of personal or confidential content to public.
Do not attach tenant records, private profiles, secrets, or real identity data
to a public concept change. Publishing a reusable implementation is separate
from onboarding a person or company into a running installation.

## Additive persona-to-identity bindings

The implementation introduced with this model adds versioned
`persona_identity_bindings` metadata to the **existing personal-agent profile**.
It records `persona_id`, `accountable_human_id`, `personal_nhi_id`, and explicit
`tenant_bindings`. This is a mapping to existing ledger identities, not a new
identity authority, personnel store, or grant store.

For example, the following is a **synthetic mapping**, not production identity
data. The file contains the mapping itself, without a surrounding
`persona_identity_bindings` key:

```json
{
  "version": 1,
  "persona_id": "example-assistant",
  "accountable_human_id": "user:example-owner",
  "personal_nhi_id": "kyberion://agent/example-personal/example-assistant",
  "tenant_bindings": [
    {
      "tenant_slug": "example-company",
      "nhi_id": "kyberion://agent/example-company/example-assistant"
    }
  ]
}
```

Use your existing profile's handle and the appropriate already-registered ledger
identities instead of these illustrative values. A URI's organization component
alone does not establish tenant affiliation; the ledger must explicitly match.
Save the proposed mapping to a scoped local JSON file, then use the governed NHI
facade:

```sh
pnpm nhi persona-show
pnpm nhi persona-bind --bindings <json-file>
pnpm nhi persona-bind --bindings <json-file> --apply --expected-revision <expected_revision>
```

`persona-show` is read-only. `persona-bind` previews by default; `--apply`
replaces the **entire mapping** after validating it against the current NHI
ledger. Copy `expected_revision` from the reviewed dry-run result into the apply
command; it is required. A shared profile write lock and revision digest reject
stale writes. If the profile changes, run and review a fresh preview rather than
retrying the stale revision.

The command does not merge omitted tenant entries, issue identities, change
accountability or affiliation, admit a runtime session, create organization
membership, or grant any capability. A valid mapping is not an activation
ceremony. Use the existing governed lifecycle and onboarding paths for those
separate operations.

Existing NHI IDs and ledger history remain intact. The legacy profile `nhi_id`
is retained as a **personal-only fallback** only when the mapping is absent;
an empty or invalid mapping does not enable this fallback. In particular,
it must not silently select a tenant identity. New tenant session admissions
require explicit matching tenant affiliation. Compatibility for old admissions
is limited to already-attested, still-live admissions, not fresh admission of an
unaffiliated identity. Revocation, expiry, and lifecycle restrictions still
apply.

Re-onboarding the same persona preserves its bindings. Renaming a handle with
populated bindings is refused until an explicit, reviewed clear: apply a mapping
with the same `version`, `persona_id`, and `accountable_human_id`, omit
`personal_nhi_id`, and set `tenant_bindings` to `[]`, using the same preview and
revision-check flow. This clears metadata only; it does not revoke an admitted
session or retire an NHI. The implementation does not promise stable persona
identity across a handle rename or automatically transfer bindings to the new
handle.

Runtime identity claims use `KYBERION_NHI_ID`; the enforcement policy remains
`KYBERION_NHI_ACTOR=off|warn|enforce`. A legacy NHI URI supplied through
`KYBERION_NHI_ACTOR` remains a compatibility claim, not a policy value. Claims
select existing governed records; neither environment variables nor persona
bindings create session authority. Session admission still requires its own
live, attested runtime binding.

Pipeline resume captures and restores the NHI verification mode separately from
the identity claim. Automatic resume refuses historical journal snapshots that
lack any required captured policy key, including `KYBERION_NHI_ACTOR`, with
“original execution authority is missing; resume from the original runtime”.
Resume or re-run from the original runtime instead of inheriting the approver's
settings. The low-level restoration helper defaults a missing NHI mode to the
restrictive `enforce` policy, but this does not bypass the automatic-resume
precondition or guarantee that historical runs can be replayed.

## Implementation boundary and remaining work

This change establishes the shared vocabulary, profile mapping, governed
mapping command, and the targeted personal/onboarding identity-resolution and
tenant-admission checks. It is intentionally additive: existing identities,
organization responsibilities, grants, and audit history retain their sources
of truth.

It does not onboard a real user or company, create grants, reassign existing
identities, or migrate every execution path. Remaining work includes auditing
all identity consumers for explicit tenant resolution, surfacing the active
identity clearly in each conversational UI, and strengthening review paths that
still equate actor-string inequality with independent identity. Each requires
its own implementation and evidence before being described as enforced.

## Existing sources of truth

- NHI identity lifecycle and journal: `libs/core/agent/agent-identity.ts`,
  `libs/core/agent/nhi-lifecycle-governance.ts`, and `scripts/nhi.ts`.
- Personal identity resolution: `libs/core/authn/personal-identity-state.ts` and
  `libs/core/authn/personal-identity-reader.ts`.
- Tenant runtime admission: `libs/core/organization/nhi-session-admission.ts`
  and `libs/core/organization/onboarding-runtime-identity.ts`.
- Organization responsibilities: `libs/core/organization/organization-participants.ts`
  and `libs/core/organization/identity-directory.ts`.
- Authority: `libs/core/governance/accountability-charter.ts`,
  `libs/core/governance/grant-resolver.ts`, and `libs/core/task/task-scoped-grants.ts`.
- Task evidence and review: the mission controller, `libs/core/mission/mission-task-evidence-binding.ts`,
  and `libs/core/mission/mission-review-gates.ts`.
- Related boundaries: [entity scope hierarchy](entity-scope-hierarchy.md),
  [tenant operations](multi-tenant-operations.md), and
  [stance / tenant / customer](stance-tenant-customer-model.md).

---
title: External Identity → Member Mapping and the Human Role Model
kind: reference
scope: repository
authority: reference
phase: [execution]
tags:
  [
    authn,
    oidc,
    external-idp,
    member-registry,
    membership,
    roles,
    owner,
    approver,
    operator,
    viewer,
    google,
    fail-closed,
  ]
owner: ecosystem_architect
last_updated: 2026-09-23
---

# External identity → member mapping and the human role model

How an outside identity (Google account, any OIDC IdP) becomes a Kyberion
member, and how the member's per-tenant role turns into an authorization
decision. Code: `libs/core/authn-providers.ts` (oidc-jwt),
`libs/core/member-registry.ts`, `libs/core/front-desk-roles.ts`,
`libs/core/authz-providers.ts` (member-membership).

## 1. The chain

```
external IdP identity          member                per-tenant            server role         permission set
(OIDC iss + sub)               (members/{id}.json)   membership role                            (authz)

iss=https://accounts.google.com ──▶ member_id=carol ──▶ acme-corp: approver ──▶ localadmin ────▶ headless.read
sub=1122334...                    external_identities    default:  viewer   ──▶ readonly  ────▶ decision.write
                                                                                              headless.write
```

1. **authn** (`oidc-jwt` provider): verifies the bearer JWT signature against
   configured JWKS and binds `iss` to `KYBERION_OIDC_ISSUER`. Then, in order:
   `member_id` claim → `user:<member>` sub → **`external_identities` lookup**
   (`findMemberByExternalIdentity`, run inside an authorized
   `withExecutionContext` — member profiles live on the personal tier) →
   unregistered `ext-<hash>` actor.
2. **member registry** (`knowledge/personal/members/{member_id}.json`): the
   single source for who a human is. `memberships` hold the per-tenant role;
   `access_registrations` bind token credentials; `external_identities` bind
   OIDC identities. An `(issuer, subject)` pair may be bound to at most one
   member — `writeMemberProfile` rejects duplicates — and member ids in the
   reserved `ext-` namespace are rejected so an unregistered external actor
   can never collide with a real member.
3. **role authority** (`frontDeskRoleAuthority`): maps each membership role to
   a server role + exact permission set.
4. **authz** (`member-membership` provider): unions the permission sets of the
   memberships that match the resource tenant and checks the operation. The
   tenant is always the resource tenant — a role held on another tenant never
   contributes.

## 2. Human roles

| Role       | Server role | Permissions                            | Can read | Can execute (write) | Can decide (approve) |
| ---------- | ----------- | -------------------------------------- | -------- | ------------------- | -------------------- |
| `owner`    | localadmin  | read + headless.write + decision.write | ✓        | ✓                   | ✓                    |
| `approver` | localadmin  | read + decision.write                  | ✓        | —                   | ✓                    |
| `operator` | localadmin  | read + headless.write                  | ✓        | ✓                   | —                    |
| `viewer`   | readonly    | read                                   | ✓        | —                   | —                    |

- `owner` — full authority (the bootstrap loopback/operator identity).
- `approver` — a member who can only _decide_: approvals, verdicts, gates.
  No generic write.
- `operator` — a member who can only _execute_: run allowed operations, but
  can never record a decision. Decide-effect routes positively allow only
  `owner`/`approver` membership roles — an operator or viewer member is
  403'd, and `decided_by` records never carry `operator`/`viewer`.
- `viewer` — read-only member.

Server roles stay `localadmin | readonly`: they gate `requiredRole` and tier
access (`localadmin` → personal+confidential+public; `readonly` →
confidential+public). The permission _set_ — not the server role — is what
distinguishes approver from operator from owner, applied via
`context.permissions` replacement semantics (surface-authorization.ts).

**Decision attribution**: `decidedBy`/`decidedByRole`/`decidedByType` are
written from the resolved member's tenant-matched membership — the tenant
the decision actually lands on (the approval's / entry's / candidate's
tenant), never `tenantSlugs[0]` of the viewer's scope. When the resource
tenant cannot be determined, every in-scope membership must be
decision-capable. The legacy `'concierge'`/`'sovereign'` fallback survives
only for an _unresolved_ principal (legacy token/loopback without a member
record) — a resolved member whose membership is missing or
non-decision-capable on the target tenant is denied, never recorded as
sovereign.

**Bound members never fall back to "unregistered".** A principal carrying an
authn-verified member binding (`memberId` from a verified claim, token
registration, or registration label) whose member is suspended or missing is
denied — at authentication for registry tokens and OIDC claims (the provider
throws `scope_denied` 403), and at every downstream member-resolution gate
(`member_denied`). Suspending a member does not revoke its chronos-access
registration or its external-identity binding, so without this rule a
suspended localadmin-class credential would be _upgraded_ to the
unregistered owner/sovereign fallback. `memberBindingDenied` and
`externalIdentityBindingDenied` are the fail-closed companions that detect
a bound-but-unresolvable member on every path — including a registration
_label_ match (a token whose registration names no `member_id` still denies
when its label matches a suspended member's `access_registrations`) and an
OIDC `iss`+`sub` bound to a suspended member. **Label-bound resolution is
two-way**: a label matching an _active_ member's `access_registrations`
upgrades the credential to that member's identity (`memberId` + `user:<id>`
actor) at authentication; a match on a suspended member — or any binding the
registry cannot disprove because a profile or the directory is unreadable —
denies at authentication. Both helpers deny when a profile cannot be read:
an unreadable profile cannot disprove the binding, so the check fails closed
rather than silently degrading to `ext-`/unregistered.

## 3. External identity binding

`member profile → external_identities[]`:

```json
{
  "member_id": "carol",
  "memberships": [{ "tenant_slug": "acme-corp", "role": "approver" }],
  "external_identities": [
    {
      "issuer": "https://accounts.google.com",
      "subject": "112233445566778899",
      "email": "carol@example.com"
    }
  ]
}
```

Resolution rules (fail closed):

- Match requires verified `iss` + `sub` on an **active** member. An asserted
  member binding that does not resolve to an active member is **denied at
  authentication (403 `scope_denied`)** — this covers a `member_id`/`user:`
  claim naming a suspended or unknown member, and an `iss`+`sub` bound to a
  suspended member. The claim can neither resurrect the member nor degrade
  into the unregistered `ext-<hash>` path, where a `kyberion_role:
localadmin` claim would otherwise re-enter as a localadmin principal.
  Only a _genuinely unbound_ external identity produces `ext-<hash>`.
- When mapped, the member's own memberships become the scope: `tenantSlugs`
  is the union of membership tenants, and `kyberion_tenants` claims plus the
  server-bound tenant may only _narrow_ that set — never widen it.
- **Flat role = weakest membership.** The resolved principal's single
  `role` is `localadmin` only when _every_ membership is localadmin-class
  (owner/approver/operator); any `viewer` membership makes it `readonly`.
  Flat consumers (role-scope authz, surface mutation gates, tier policy)
  apply that role scope-wide, so a strongest-role rule would bleed owner
  authority into tenants where the member only views. Per-tenant precision
  is recovered by member-aware paths: the `member-membership` authz provider
  re-derives the role from the membership matching the resource tenant, and
  member resolution consumes the authn-verified `memberId`
  (`resolveMemberByPrincipal`).
- When unmapped, the principal keeps a grammar-valid `ext-<hash>` actor with
  no memberId — `member-membership` authz denies it; only the readonly
  role-scope path remains.
- A corrupt/unreadable profile is skipped during the external-identity scan
  (it cannot prove a binding) — it never aborts the lookup for other
  members.

## 4. Google (OIDC) configuration

```bash
KYBERION_OIDC_ISSUER=https://accounts.google.com
KYBERION_OIDC_AUDIENCE=<your OAuth client ID>
# JWKS — one of:
#   deps.jwks           (surface adapter pre-fetches https://www.googleapis.com/oauth2/v3/certs)
#   KYBERION_OIDC_JWKS  (inline JWKS JSON)
#   KYBERION_OIDC_JWKS_PATH (repo-relative JWKS file)
```

The seam is synchronous and never touches the network itself — JWKS
pre-fetch/rotation is the adapter's job. Google cannot mint `kyberion_*`
claims, which is exactly what `external_identities` is for: the member
profile — not the token — carries tenant/role authority. Custom-claim IdPs
(Keycloak, Auth0, Okta) can still use `kyberion_tenants`/`member_id` claims;
explicit claims win over the external-identity lookup.

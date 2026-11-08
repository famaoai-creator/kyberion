---
title: 'Installation-owner authorization — who may change settings of the whole machine'
tags: [governance, security, authorization, concierge, passkey, loopback, settings]
last_updated: 2026-11-08
---

# Installation-owner authorization

Some Concierge settings apply to the whole installation, not to one tenant or
member: operator service credentials (`/api/services/operator`,
`/api/secrets/*`, `/api/oauth/begin|operation`), the owner's personal profile,
voice samples and avatar (`/api/setup`, `/api/setup/avatar-generation`,
`/api/me/avatar*`), and personal onboarding authority
(`/api/onboarding-authority?scope_kind=person`).

These are authorized by **who is asking and how strongly they proved it**.
Loopback is only a factor. One helper decides every case:
`libs/core/surface/installation-owner-access.ts`. Concierge reaches it through
`presence/displays/concierge/src/lib/installation-access.ts`.

## Who the installation owner is

An authenticated human principal that meets all of these:

- source `token` or `oidc` (browser session, OIDC JWT, or member-bound registry token)
- role `localadmin`: the full owner registration. A readonly or other
  narrowed credential bound to `owner` is refused
- assurance above `none`, and not expired
- member id equal to the local owner member (`FIRST_RUN_DEFAULT_MEMBER_ID`,
  `owner`, shown as `is_local_owner`)
- an `active` member profile

Env tokens (`KYBERION_LOCALADMIN_TOKEN`), agent principals and other members
(approver, operator, viewer) are never the installation owner, whatever their
role.

## Decision table

| Request                                                         | Read                              | Write                               |
| --------------------------------------------------------------- | --------------------------------- | ----------------------------------- |
| Owner on a trusted loopback peer                                | yes                               | yes                                 |
| Owner on another device, no step-up                             | yes                               | 403 `installation_step_up_required` |
| Owner on another device, passkey step-up in the last 5 min      | yes                               | yes (audited `step_up: true`)       |
| Owner whose step-up is older than 5 min or from another session | yes                               | 403 `installation_step_up_required` |
| Owner member suspended or missing                               | 403 `installation_owner_required` | same                                |
| Another member, or a readonly credential bound to `owner`       | 403 `installation_owner_required` | same                                |
| Expired credential                                              | 401 `authentication_required`     | same                                |
| No credential, loopback, bootstrap open                         | yes                               | yes                                 |
| No credential, loopback, owner bound                            | 401 `authentication_required`     | same                                |
| No credential, loopback, escape hatch on                        | yes                               | yes                                 |
| No credential, remote                                           | 401                               | 401                                 |

Read answers never include secret values. Every installation-scope write,
allowed or refused, is audited (`installation_scope_write`) with the actor,
the transport (`loopback` or `remote`) and whether a step-up admitted it. If
the audit record cannot be written, an admitted write is refused with 503
`installation_audit_unavailable`.

Installation-scope writes include deciding a personal-scope
onboarding-authority approval card (`POST /api/approvals/<id>`). Deciding
with a passkey (`/api/approvals/<id>/passkey`) is itself a fresh passkey
assertion, so that route needs no separate step-up.

Inputs come only from server-side evidence: the verified principal, the
transport adapter's loopback attestation (`server/local-peer.ts`, never
`x-forwarded-for` or `Host`), the step-up record, and the first-run status.
Request parameters never decide.

## Passkey step-up for remote writes

The owner confirms with the existing HA-07 step-up ceremony, using purpose
`installation`. The two calls are `POST /api/me/passkeys`
`{action: 'step_up_options', purpose: 'installation'}` and then
`{action: 'step_up_verify', response}`. Verifying spends the single-use
step-up. It also writes one record to the owner's passkey file
(`installation_step_up`) holding the hash of the browser session's
credential, the verification time and the confirming passkey
(`libs/core/authn/installation-step-up.ts`). A remote write is admitted when
all of these hold:

- the record is from the same session
- it is at most 5 minutes old
- the confirming passkey is still usable

The browser never holds an installation token. A step-up needs a browser
session and a usable passkey. Recording a step-up is audited
(`passkey` / `installation_step_up`) and notifies the operator.

The owner's **first** usable passkey can be registered only from a trusted
loopback peer. Otherwise a stolen remote owner session could register its
own key and then step up. Remote error:
`installation_owner_first_passkey_loopback_required`. Later passkeys need a
step-up from an existing passkey. The enrollment cooldown and the operator
notification still apply, and a new passkey cannot confirm until its
cooldown ends.

## Anonymous loopback is retired once an owner is bound

A credential-less loopback request is the local operator (Concierge
`localadmin`) only while **bootstrap is open**. Bootstrap is open while all
of these hold (`readFirstRunStatus` in `libs/core/surface/first-run-setup.ts`):

- first-run setup is unclaimed
- the `owner` member holds no credential (registry token or bound IdP
  identity), whatever its memberships
- no active member with an owner membership holds one

Closure is **sticky**: the first time bootstrap is seen closed, the first-run
document records `bootstrap_closed_at`. Revoking the credential later never
re-opens it. Once bootstrap is closed:

- Concierge viewer resolution returns 401 for a credential-less loopback
  request, so other OS users and local processes are no longer an admin.
- Browser page navigations from loopback are sent to `/login`.
- These stay public: `/login`, `/auth/*`, `/signin`, `/setup/first-run`,
  `/api/setup/first-run`, and `/api/healthz`. `/api/healthz` is the surface
  runtime probe and returns only `{ok: true}`.

The bootstrap probe is cached for 5 seconds per process, and it fails
closed. Member profile writes, owner-bound token issuance and the first-run
claim invalidate that cache at once (`installation-bootstrap-signal.ts`).

## Recovery: bootstrap closed but the owner cannot sign in

This happens when another member's credential closed bootstrap before the
`owner` member had one, or when the owner lost its only credential. The UI
shows "sign in as the installation owner" with this recovery hint. On the
machine itself (the host terminal is the trusted operator):

1. `pnpm organization member ensure-owner` provisions the `owner` member if
   it is missing. It is idempotent.
2. `pnpm organization member link-identity owner --issuer <iss> --subject <sub>`
   binds the owner's IdP subject. For the local dev IdP:
   `--issuer http://localhost:9099 --subject dev-user`.
3. Sign in at `/login` as that identity. Register the first passkey from the
   machine itself (loopback) if you will change settings remotely.

SSO settings belong to the instance owner (owner of every tenant). If the
`owner` member has no tenant memberships, grant them first with
`pnpm organization member grant owner --tenant <slug> --role owner --apply`.

If no IdP is configured yet, start Concierge once with
`KYBERION_CONCIERGE_ALLOW_ANONYMOUS_LOOPBACK=1`. Configure SSO at
`/setup/sso` from the machine, then unset the variable and use the steps
above. `pnpm organization first-run code` works only while first-run setup
is unclaimed, so it is not a recovery path once bootstrap has closed.

## Escape hatch for headless automation

`KYBERION_CONCIERGE_ALLOW_ANONYMOUS_LOOPBACK=1` is off by default and listed
in the env registry. It keeps credential-less loopback acting as the local
operator after an owner is bound. Examples are screenshot capture and local
scripts that cannot sign in. It never applies to a remote peer. While it is
on, Concierge logs a diagnostic-format warning once per process. Prefer
authenticating the automation as the owner, and unset the variable when done.

## Migration

`KYBERION_LOCALADMIN_TOKEN`, other env tokens and agent principals now get
`installation_owner_required` on installation-scope settings. Before, a
loopback request could reach them without signing in. Use one of these
instead:

- a registry token bound to the `owner` member with role `localadmin`
  (for example the first-run token)
- the escape hatch, for local automation that cannot sign in

## Owner-only hearing and conversation routes

Concierge `/api/hearing/*` and `/api/conversation` (moved from Presence
Studio) use the same owner decision: reads of a tenant hearing are open to
any viewer of that tenant, while the personal hearing store, decision
receipts, the conversation and every write need the installation owner.
Writes are browser requests. Each POST must carry an `Origin` (or `Referer`)
that matches the Host it was sent to, whatever the credential. A bearer API
client without one gets 403 `hearing_origin_denied`, as does a cross-site
page. Decision-ledger hearings answer 503 `hearing_ledger_unavailable`,
because the concierge role does not assume `decision_ledger`. The gate is in
`presence/displays/concierge/src/lib/hearing-access.ts`.

## Related

- [dev-idp-onboarding-runbook](./dev-idp-onboarding-runbook.md): signing in as the owner locally
- [multi-tenant-operations](../architecture/multi-tenant-operations.md)
